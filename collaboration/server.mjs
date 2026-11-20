import { randomBytes, randomUUID, createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { normalizeLoadout } from '../layout/mods/runespace/equipment.js';
import { Simulation, ACTIVITY } from '../layout/mods/runespace/world-engine.js';
import { readRosterViews, rosterId, memberRoster, validMemberId } from './agents.mjs';
import { createHostActions } from './host-actions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worldFiles = resolve(here, '../layout/mods/runespace');
const sdkDirectory = dirname(createRequire(import.meta.url).resolve('livekit-client'));
const files = new Map([
  ['/', [join(here, 'index.html'), 'text/html']],
  ['/embedded-guild.html', [join(here, 'embedded-guild.html'), 'text/html']],
  ...['embedded-guild.js', 'style.css', 'client.js', 'media.js', 'agent-scene.js', 'world.js', 'adventure-profile.js', 'host-ui.js'].map(name => [
    '/' + name, [join(here, name), name.endsWith('.css') ? 'text/css' : 'text/javascript']
  ]),
  ...['world-engine.js', 'world-art.js', 'equipment.js'].map(name => [
    '/world/' + name, [join(worldFiles, name), 'text/javascript']
  ]),
  ['/world/fonts/PixelatedMSSansSerif-Regular.ttf', [join(worldFiles, 'fonts/PixelatedMSSansSerif-Regular.ttf'), 'font/ttf']],
  ['/vendor/livekit-client.umd.min.js', [join(sdkDirectory, 'livekit-client.umd.js'), 'text/javascript']],
]);
const secret = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest();
const fail = (status, message) => Object.assign(new Error(message), { status });
const normalizeAngle = yaw => Math.atan2(Math.sin(yaw), Math.cos(yaw));

function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw fail(415, 'Send application/json.');
  }
  return (async () => {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) throw fail(413, 'Request is too large.');
      chunks.push(chunk);
    }
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw fail(400, 'Invalid JSON.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(400, 'Expected a JSON object.');
    return parsed;
  })();
}

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function settings(env = process.env) {
  const rawMedia = [env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET];
  if (rawMedia.some(Boolean) && !rawMedia.every(Boolean)) throw new Error('Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET together.');
  return {
    host: env.RUNESPACE_HOST || '127.0.0.1', port: Number(env.RUNESPACE_PORT ?? 8787),
    origin: env.RUNESPACE_ORIGIN, guestOrigin: env.RUNESPACE_GUEST_ORIGIN, invite: env.RUNESPACE_INVITE, agentRoster: env.RUNESPACE_AGENT_ROSTER,
    desktop: env.RUNESPACE_OWNER_TOKEN || env.RUNESPACE_HERDR_CLI || env.RUNESPACE_HERDR_MOD
      ? {token: env.RUNESPACE_OWNER_TOKEN, cli: env.RUNESPACE_HERDR_CLI, mod: env.RUNESPACE_HERDR_MOD} : null,
    livekit: rawMedia.every(Boolean) ? { url: rawMedia[0], apiKey: rawMedia[1], apiSecret: rawMedia[2] } : null
  };
}

export function createRoomServer(options = {}) {
  const { host = '127.0.0.1', port = 8787, livekit, agentRoster, resumeMs = 45_000, capacity = 32, sceneMaxAgeMs = 10_000, rosterMaxAgeMs = 20_000 } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid room service port.');
  const invite = options.invite || secret();
  if (invite.length < 16 || invite.length > 512) throw new Error('Use an invitation of 16–512 characters.');
  const inviteHash = digest(invite);
  const desktop = createHostActions(options.desktop, invite, agentRoster);
  function parseOrigin(value, setting) {
    if (!value) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== url.origin + '/')
      throw new Error(setting + ' must be a full HTTP(S) origin without a path.');
    return url.origin;
  }
  const configuredOrigin = parseOrigin(options.origin, 'RUNESPACE_ORIGIN');
  const guestOrigin = parseOrigin(options.guestOrigin, 'RUNESPACE_GUEST_ORIGIN');
  if (guestOrigin && (!configuredOrigin || !guestOrigin.startsWith('https:') || configuredOrigin === guestOrigin))
    throw new Error('Set a distinct HTTPS guest gateway and an explicit RUNESPACE_ORIGIN for the desktop.');
  if (!configuredOrigin && !['127.0.0.1', '::1', 'localhost'].includes(host))
    throw new Error('Set RUNESPACE_ORIGIN when listening beyond localhost.');
  if (livekit) {
    const u = new URL(livekit.url);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw new Error('LIVEKIT_URL must be a WebSocket endpoint.');
    if ((guestOrigin || configuredOrigin?.startsWith('https:')) && u.protocol !== 'wss:') throw new Error('Use a wss:// LiveKit endpoint with an HTTPS team room.');
  }
  // A room name belongs to one running authority, so restarting cannot reconnect old media clients to a new guild.
  const roomName = 'runespace-' + randomUUID();
  const sim = new Simulation();
  const sessions = new Map();
  let nextSessionOrder = 0;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32768, perMessageDeflate: false });
  const server = new Server();
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  let origin, broadcastTimer, maintenance, refreshTimer, readingRoster = false, stopping = false;
  let agentViews = {guests: [], owner: [], bindings: {}};
  const trustedOrigins = new Set([configuredOrigin, guestOrigin].filter(Boolean));
  const allowedOrigin = value => trustedOrigins.size ? trustedOrigins.has(value) : [
    'http://127.0.0.1:', 'http://localhost:', 'http://[::1]:'
  ].some(base => value === base + server.address()?.port);

  const publishers = new Map();
  let hostSharing = true, sceneHost = null, sceneTimer, walkingTimer;
  let townRoster, placed, expandedCommons = false;
  function rosterChanged() {
    townRoster = null;
    publish();
  }
  function expandCommons() {
    // A full room can bring more idle characters than a single desktop's fire rings.
    // Fill the remaining walkable tiles outwards from the fire, retaining reserved stations.
    const reserved = sim.commons.concat(...Object.values(sim.stations)), extra = [];
    for (let z=-18.5;z<=18.5;z+=.5) for (let x=-19.5;x<=19.5;x+=.5) {
      const radius = x*x + (z-3)*(z-3);
      if (radius < 4 || sim.blocked(x,z) || reserved.some(p => (x-p.x)**2+(z-p.z)**2 < .25)) continue;
      extra.push({x,z,faceX:0,faceZ:3,radius});
    }
    extra.sort((a,b) => a.radius-b.radius);
    sim.commons.push(...extra);
    expandedCommons = true;
  }
  function releaseScene(session) {
    if (session !== sceneHost) return;
    clearTimeout(sceneTimer);
    sceneHost = null;
    publish();
  }
  function updateScene(session, entries, ids) {
    if (!session.hostDesktop || !Array.isArray(entries) || entries.length > 64) return;
    const scene = new Map();
    for (const row of entries) {
      if (!Array.isArray(row)) continue;
      const [key,x,z,yaw,activity,moving] = row;
      if (typeof key !== 'string' || key.length > 512 || ![x,z,yaw].every(Number.isFinite) ||
          Math.abs(x)>20 || Math.abs(z)>19 || typeof activity !== 'string' || !Object.hasOwn(ACTIVITY, activity)) continue;
      const id = ids ? ids[key] : rosterId(key);
      if (typeof id === 'string') scene.set(id, [id,x,z,normalizeAngle(yaw),activity,moving === true]);
    }
    if (!scene.size) { releaseScene(session); return; }
    clearTimeout(sceneTimer);
    sceneHost = session;
    sceneTimer = setTimeout(() => releaseScene(session), sceneMaxAgeMs);
    session.scene = [...scene.values()];
    publish();
  }
  function clearContribution(session) {
    clearTimeout(session.rosterTimer);
    session.rosterTimer = null;
    if (session.roster) { session.roster = null; rosterChanged(); }
  }
  function updateRoster(session, message) {
    if (!session.native || publishers.get(session.namespace) !== session) return;
    if (message.sharing !== undefined && typeof message.sharing !== 'boolean') return;
    if (message.sharing !== undefined) session.sharing = message.sharing;
    if (session.hostDesktop) {
      if (session.sharing !== hostSharing) { hostSharing = session.sharing; rosterChanged(); }
      if (!hostSharing) { releaseScene(session); return; }
      if (message.scene) updateScene(session, message.scene, agentViews.bindings);
      return;
    }
    if (!session.sharing) { clearContribution(session); return; }
    if (!Array.isArray(message.agents) || message.agents.length > 64) return;
    const next = memberRoster(message.agents, session.namespace);
    if (!next.agents.length) { clearContribution(session); return; }
    if (JSON.stringify(next) !== JSON.stringify(session.roster)) {
      session.roster = next;
      rosterChanged();
    }
    clearTimeout(session.rosterTimer);
    session.rosterTimer = setTimeout(() => clearContribution(session), rosterMaxAgeMs);
  }

  function collectRoster(connected) {
    const hostSession = connected.find(s => s.hostDesktop && publishers.get(s.namespace) === s);
    const host = {ownerId:hostSession?.peer.id ?? null, ownerName:hostSession?.peer.name ?? 'Guild host', hostAgent:true};
    const agents = hostSharing ? agentViews.guests.map(a => ({...a,...host})) : [];
    const team = connected.filter(s => s.roster?.agents.length);
    for (const s of team) {
      for (const a of s.roster.agents) agents.push({...a, ownerId:s.peer.id, ownerName:s.peer.name, hostAgent:false});
    }
    // Everyone uses the same assignment once a visiting desktop shares agents. The game's
    // allocator keeps existing station reservations through roster changes and queues overflow.
    if (!expandedCommons && agents.length > sim.commons.length) expandCommons();
    sim.sync(agents.map(a => ({key:a.id, kind:a.kind, name:a.name, status:a.status})));
    placed = null;
    const owners = hostSharing ? agentViews.owner.map(a => ({...a,...host})).concat(agents.slice(agentViews.guests.length)) : agents;
    return {agents, owners, sharedStations:team.length > 0};
  }
  function broadcast() {
    broadcastTimer = null;
    const connected = [...sessions.values()].filter(s => s.socket);
    if (!connected.length) return;
    const peers = connected.map(s => s.peer);
    const {agents,owners,sharedStations} = townRoster ??= collectRoster(connected);
    placed ??= [...sim.npcs.values()].map(p => [p.key,p.x,p.z,p.yaw,p.activity,p.moving]);
    const hostScene = hostSharing && sceneHost?.socket
      ? sceneHost.scene.filter(([id]) => sim.npcs.has(id)) : [];
    const hostPoses = new Map(hostScene.map(row => [row[0],row]));
    const nativeFallback = !sharedStations && placed.map(row => hostPoses.get(row[0]) ?? row);
    for (const s of connected) {
      const ws = s.socket;
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount > 256*1024) { ws.terminate(); continue; }
      const ownAgentIds = s.hostDesktop ? agentViews.bindings : s.roster?.bindings ?? {};
      const scene = sharedStations ? placed : s.native && !s.hostDesktop ? nativeFallback : hostScene;
      ws.send(JSON.stringify({type:'world', self:s.peer.id, peers, agents:s.isOwner ? owners : agents, scene,
        sharedStations, ...(s.native && {hostDesktop:s.hostDesktop, ownAgentIds})}));
    }
    if (!walkingTimer && placed.some(row => sim.npcs.get(row[0]).path.length)) {
      walkingTimer = setInterval(() => {
        if (![...sim.npcs.values()].some(npc => npc.path.length)) { clearInterval(walkingTimer); walkingTimer=null; return; }
        sim.step(.1); placed = null; publish();
      }, 100);
    }
  }
  function publish() {
    if (!broadcastTimer && !stopping) broadcastTimer = setTimeout(broadcast, 50);
  }
  async function refreshAgents() {
    if (!agentRoster || readingRoster || stopping) return;
    readingRoster = true;
    try {
      const next = await readRosterViews(agentRoster, desktop?.mod, options.desktop?.token);
      if (JSON.stringify(next) !== JSON.stringify(agentViews)) { agentViews = next; rosterChanged(); }
    } catch {
      if (agentViews.guests.length) { agentViews = {guests: [], owner: [], bindings: {}}; rosterChanged(); }
    } finally { readingRoster = false; }
  }
  function disconnected(session) {
    clearContribution(session);
    if (publishers.get(session.namespace) === session) publishers.delete(session.namespace);
    releaseScene(session);
    rosterChanged();
  }

  function active(token) {
    const session = sessions.get(token);
    if (session && !session.socket && session.expires <= Date.now()) { sessions.delete(token); return null; }
    return session;
  }
  function spawn(name) {
    // Pick a free spot by the fire when possible. Peers may pass one another.
    const taken = [...sessions.values()].map(s => s.peer);
    let x = 0, z = 12;
    for (let i = 0; i < 32; i++) {
      const angle = i * 2.4, radius = Math.sqrt(i) * .62;
      const at = { x: Math.cos(angle) * radius, z: 12 + Math.sin(angle) * radius };
      if (!sim.blocked(at.x, at.z) && taken.every(p => Math.hypot(p.x-at.x, p.z-at.z) > .58)) {
        x = at.x; z = at.z; break;
      }
    }
    return { id: randomUUID(), name, x, z, yaw: Math.PI, seq: 0 };
  }
  function move(session, input) {
    if (![input.x, input.z, input.yaw].every(Number.isFinite)) return;
    if (!Number.isSafeInteger(input.seq) || input.seq <= session.peer.seq) return;
    const peer = session.peer;
    const now = performance.now();
    // Accumulate a distance budget by elapsed time. The cap allows jitter without permitting stored-up teleports.
    session.budget = Math.min(1.6, session.budget + (now-session.lastMove) * .0055);
    session.lastMove = now;
    // A defeated adventurer returns only to the commons spawn.
    if (input.recover === true && input.x === 0 && input.z === 12) {
      peer.x = 0; peer.z = 12;
    }
    const startX = peer.x, startZ = peer.z;
    if (session.nativeHost || session.needsNativeSpawn) {
      // A newly opened presenter can report its saved spawn after it joins the call.
      if (!sim.blocked(input.x, input.z)) {
        peer.x = input.x;
        peer.z = input.z;
        session.needsNativeSpawn = false;
      } else if (session.needsNativeSpawn) return;
    }
    const dx = input.x - peer.x, dz = input.z - peer.z, length = Math.hypot(dx, dz);
    if (!session.nativeHost && Number.isFinite(length) && length > 0) {
      const fraction = Math.min(1, session.budget / length);
      const next = { x: peer.x + dx*fraction, z: peer.z + dz*fraction };
      if (sim.clearSegment(peer, next)) {
        session.budget = Math.max(0, session.budget - length*fraction);
        Object.assign(peer, next);
      }
    }
    peer.moving = typeof input.moving === 'boolean' ? input.moving : Math.hypot(startX-peer.x,startZ-peer.z) > .01;
    if (['idle', 'wood', 'attack', 'dance'].includes(input.activity)) peer.activity = input.activity;
    if (input.loadout && typeof input.loadout === 'object') peer.loadout = normalizeLoadout(input.loadout);
    peer.seq = input.seq;
    peer.yaw = normalizeAngle(input.yaw);
    publish();
  }

  server.on('request', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss: ws: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [file, mime] = files.get(path);
        const stream = createReadStream(file);
        stream.once('open', () => {
          res.writeHead(200, { 'Content-Type': mime });
          stream.pipe(res);
        });
        stream.once('error', () => { if (!res.headersSent) reply(res, 404, { error: 'File unavailable.' }); else res.destroy(); });
        res.once('close', () => stream.destroy());
        return;
      }
      if (req.method !== 'POST' || !['/api/join', '/api/media', '/api/leave', '/api/agent-chat', '/api/herdr-world'].includes(path)) throw fail(404, 'Not found.');
      if (!allowedOrigin(req.headers.origin)) throw fail(403, 'Unexpected request origin.');
      if (path === '/api/join') {
        const { invite: invitation, name, owner, client, position, shareAgents, contributorKey } = await body(req);
        if (typeof invitation !== 'string' || !timingSafeEqual(digest(invitation), inviteHash)) throw fail(403, 'Invalid invitation.');
        if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 32 || /[\p{Cc}\p{Cf}]/u.test(name)) throw fail(400, 'Enter a display name of 1–32 characters.');
        if (sessions.size >= capacity) {
          for (const token of sessions.keys()) active(token);
          if (sessions.size >= capacity) throw fail(429, 'The guild is full.');
        }
        const token = secret();
        const peer = spawn(name.trim());
        const isOwner = (!guestOrigin || req.headers.origin === configuredOrigin) && desktop?.authenticates(owner) === true;
        const nativeHost = isOwner && client === 'herdr';
        if (client === 'herdr' && position && [position.x,position.z,position.yaw].every(Number.isFinite) && !sim.blocked(position.x,position.z)) {
          Object.assign(peer, {x:position.x, z:position.z, yaw:normalizeAngle(position.yaw)});
        }
        const needsNativeSpawn = client === 'herdr' && !nativeHost && position == null;
        const native = client === 'herdr', hostDesktop = nativeHost && Boolean(agentRoster);
        const namespace = native ? createHmac('sha256', inviteHash).update(hostDesktop ? 'host' :
          'guest/' + (validMemberId(contributorKey) ? contributorKey : peer.id)).digest('hex') : null;
        const sharing = shareAgents === true || (hostDesktop && shareAgents !== false);
        sessions.set(token, { peer, isOwner, nativeHost, native, hostDesktop, namespace, sharing, order:++nextSessionOrder, needsNativeSpawn, socket: null, expires: Date.now()+resumeMs, budget: 1, lastMove: performance.now() });
        return reply(res, 201, { id: peer.id, session: token, media: Boolean(livekit), ...(guestOrigin && {guestOrigin}), canOpenChats: isOwner && Boolean(agentRoster), canOpenWorld: isOwner });
      }
      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
      const session = active(token);
      if (!session) throw fail(401, 'Rejoin the guild to continue.');
      if (path === '/api/leave') {
        sessions.delete(token);
        disconnected(session);
        const socket = session.socket;
        session.socket = null;
        socket?.close(1000, 'Left the guild');
        publish();
        return reply(res, 200, { ok: true });
      }
      if (path === '/api/agent-chat' || path === '/api/herdr-world') {
        if (!session.isOwner) throw fail(403, 'Desktop actions are available to the guild host.');
        if (!session.socket) throw fail(409, 'Reconnect to the guild to open Herdr.');
        if (path === '/api/agent-chat') {
          const {id} = await body(req);
          if (!hostSharing || typeof id !== 'string' || !/^[0-9a-f]{18}$/.test(id)) throw fail(404, 'This agent belongs to another desktop or has left the guild.');
          await desktop.openChat(id);
        }
        else await desktop.openWorld();
        return reply(res, 200, {ok: true});
      }
      if (!livekit) throw fail(503, 'Voice and video are unavailable in this guild.');
      if (!session.socket) throw fail(409, 'Connect to the guild before joining voice or video.');
      const access = new AccessToken(livekit.apiKey, livekit.apiSecret, { identity: session.peer.id, name: session.peer.name, ttl: '5m' });
      access.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: false, canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE] });
      return reply(res, 200, { url: livekit.url, token: await access.toJwt() });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, error.status || 500, { error: error.status ? error.message : 'Room service error.' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/presence' || !allowedOrigin(req.headers.origin) || stopping || sockets.clients.size >= capacity*2+8) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    let session;
    let allowance = 40, lastInput = performance.now();
    const helloTimer = setTimeout(() => ws.close(1008, 'Send your session'), 5000);
    ws.alive = true;
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data, binary) => {
      const now = performance.now();
      allowance = Math.min(40, allowance + (now-lastInput)*.03) - 1;
      lastInput = now;
      if (allowance < 0 || binary) { ws.close(1008, 'Invalid message'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
      if (!session) {
        if (message?.type !== 'hello' || typeof message.session !== 'string' || !(session = active(message.session))) {
          ws.close(1008, 'Rejoin the guild'); return;
        }
        clearTimeout(helloTimer);
        const previous = session.socket;
        session.socket = ws;
        if (session.native) {
          const old = publishers.get(session.namespace);
          if (!old || old.order <= session.order) {
            if (old && old !== session) disconnected(old);
            publishers.set(session.namespace, session);
            if (session.hostDesktop) hostSharing = session.sharing;
          }
        }
        previous?.close(4001, 'Session resumed elsewhere');
        rosterChanged();
      } else if (session.socket === ws) {
        if (message?.type === 'move') move(session, message);
        else if (message?.type === 'roster') updateRoster(session, message);
        else if (message?.type === 'scene' && publishers.get(session.namespace) === session && hostSharing) updateScene(session, message.agents);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (session?.socket === ws) { session.socket = null; disconnected(session); session.expires = Date.now()+resumeMs; publish(); }
    });
  });
  return {
    server,
    async listen() {
      await new Promise((ok, no) => { server.once('error', no); server.listen(port, host, () => { server.off('error', no); ok(); }); });
      const bound = server.address();
      origin = configuredOrigin || 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + bound.port;
      maintenance = setInterval(() => {
        for (const token of sessions.keys()) active(token);
        for (const ws of sockets.clients) {
          if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); }
        }
      }, 10_000);
      await refreshAgents();
      if (agentRoster) refreshTimer = setInterval(refreshAgents, 5000);
      return { origin, inviteLink: (guestOrigin || origin) + '/#invite=' + encodeURIComponent(invite) };
    },
    async close() {
      stopping = true;
      clearInterval(maintenance); clearInterval(refreshTimer); clearTimeout(broadcastTimer); clearTimeout(sceneTimer); clearInterval(walkingTimer);
      for (const s of sessions.values()) clearTimeout(s.rosterTimer);
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      sessions.clear();
      await new Promise(ok => { server.close(ok); server.closeAllConnections(); });
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = settings();
    const room = createRoomServer(options);
    const { origin, inviteLink } = await room.listen();
    console.log('RuneSpace team room at ' + origin);
    if (!options.invite) console.log('Invitation: ' + inviteLink);
    const stop = () => { room.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
