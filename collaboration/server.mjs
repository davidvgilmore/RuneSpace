import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { AccessToken, TrackSource } from 'livekit-server-sdk';
import { normalizeLoadout } from '../layout/mods/runespace/equipment.js';
import { Simulation } from '../layout/mods/runespace/world-engine.js';
import { readRosterViews } from './agents.mjs';
import { createHostActions } from './host-actions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worldFiles = resolve(here, '../layout/mods/runespace');
const sdkDirectory = dirname(createRequire(import.meta.url).resolve('livekit-client'));
const files = new Map([
  ['/', [join(here, 'index.html'), 'text/html']],
  ...['style.css', 'client.js', 'media.js', 'world.js', 'adventure-profile.js', 'host-ui.js'].map(name => [
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
    origin: env.RUNESPACE_ORIGIN, invite: env.RUNESPACE_INVITE, agentRoster: env.RUNESPACE_AGENT_ROSTER,
    desktop: env.RUNESPACE_OWNER_TOKEN || env.RUNESPACE_HERDR_CLI || env.RUNESPACE_HERDR_MOD
      ? {token: env.RUNESPACE_OWNER_TOKEN, cli: env.RUNESPACE_HERDR_CLI, mod: env.RUNESPACE_HERDR_MOD} : null,
    livekit: rawMedia.every(Boolean) ? { url: rawMedia[0], apiKey: rawMedia[1], apiSecret: rawMedia[2] } : null
  };
}

export function createRoomServer(options = {}) {
  const { host = '127.0.0.1', port = 8787, livekit, agentRoster, resumeMs = 45_000, capacity = 32 } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid room service port.');
  const invite = options.invite || secret();
  if (invite.length < 16 || invite.length > 512) throw new Error('Use an invitation of 16–512 characters.');
  const inviteHash = digest(invite);
  const desktop = createHostActions(options.desktop, invite, agentRoster);
  let configuredOrigin;
  if (options.origin) {
    const url = new URL(options.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href !== url.origin + '/') throw new Error('RUNESPACE_ORIGIN must be a full HTTP(S) origin without a path.');
    configuredOrigin = url.origin;
  } else if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Set RUNESPACE_ORIGIN when listening beyond localhost.');
  }
  if (livekit) {
    const u = new URL(livekit.url);
    if (!['ws:', 'wss:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw new Error('LIVEKIT_URL must be a WebSocket endpoint.');
    if (configuredOrigin?.startsWith('https:') && u.protocol !== 'wss:') throw new Error('Use a wss:// LiveKit endpoint with an HTTPS team room.');
  }
  // A room name belongs to one running authority, so restarting cannot reconnect old media clients to a new guild.
  const roomName = 'runespace-' + randomUUID();
  const sim = new Simulation();
  const sessions = new Map();
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
  const server = new Server();
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  let origin, broadcastTimer, maintenance, refreshTimer, readingRoster = false, stopping = false;
  let agentViews = {guests: [], owner: []};
  const allowedOrigin = value => configuredOrigin ? value === configuredOrigin : [
    'http://127.0.0.1:', 'http://localhost:', 'http://[::1]:'
  ].some(base => value === base + server.address()?.port);

  function snapshot(session, peers) {
    const ws = session.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); return; }
    ws.send(JSON.stringify({ type: 'world', self: session.peer.id, peers, agents: session.isOwner ? agentViews.owner : agentViews.guests }));
  }
  function publish() {
    if (broadcastTimer || stopping) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const connected = [...sessions.values()].filter(s => s.socket);
      const peers = connected.map(s => s.peer);
      for (const session of connected) snapshot(session, peers);
    }, 50);
  }
  async function refreshAgents() {
    if (!agentRoster || readingRoster || stopping) return;
    readingRoster = true;
    try {
      const next = await readRosterViews(agentRoster, desktop?.mod);
      if (JSON.stringify(next) !== JSON.stringify(agentViews)) { agentViews = next; publish(); }
    } catch {
      if (agentViews.guests.length) { agentViews = {guests: [], owner: []}; publish(); }
    } finally { readingRoster = false; }
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
    const dx = input.x - peer.x, dz = input.z - peer.z, length = Math.hypot(dx, dz);
    if (Number.isFinite(length) && length > 0) {
      const fraction = Math.min(1, session.budget / length);
      const next = { x: peer.x + dx*fraction, z: peer.z + dz*fraction };
      if (sim.clearSegment(peer, next)) {
        session.budget = Math.max(0, session.budget - length*fraction);
        Object.assign(peer, next);
      }
    }
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
        const { invite: invitation, name, owner } = await body(req);
        if (typeof invitation !== 'string' || !timingSafeEqual(digest(invitation), inviteHash)) throw fail(403, 'Invalid invitation.');
        if (typeof name !== 'string' || !name.trim() || [...name.trim()].length > 32 || /[\p{Cc}\p{Cf}]/u.test(name)) throw fail(400, 'Enter a display name of 1–32 characters.');
        if (sessions.size >= capacity) {
          for (const token of sessions.keys()) active(token);
          if (sessions.size >= capacity) throw fail(429, 'The guild is full.');
        }
        const token = secret();
        const peer = spawn(name.trim());
        const isOwner = desktop?.authenticates(owner) === true;
        sessions.set(token, { peer, isOwner, socket: null, expires: Date.now()+resumeMs, budget: 1, lastMove: performance.now() });
        return reply(res, 201, { id: peer.id, session: token, media: Boolean(livekit), canOpenChats: isOwner && Boolean(agentRoster), canOpenWorld: isOwner });
      }
      const auth = req.headers.authorization;
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
      const session = active(token);
      if (!session) throw fail(401, 'Rejoin the guild to continue.');
      if (path === '/api/leave') {
        sessions.delete(token);
        session.socket?.close(1000, 'Left the guild');
        publish();
        return reply(res, 200, { ok: true });
      }
      if (path === '/api/agent-chat' || path === '/api/herdr-world') {
        if (!session.isOwner) throw fail(403, 'Desktop conversations and the personal guild belong to the host.');
        if (!session.socket) throw fail(409, 'Reconnect to the team guild to open Herdr.');
        if (path === '/api/agent-chat') await desktop.openChat((await body(req)).id);
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
        previous?.close(4001, 'Session resumed elsewhere');
        publish();
      } else if (session.socket === ws && message?.type === 'move') move(session, message);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (session?.socket === ws) { session.socket = null; session.expires = Date.now()+resumeMs; publish(); }
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
      return { origin, inviteLink: origin + '/#invite=' + encodeURIComponent(invite) };
    },
    async close() {
      stopping = true;
      clearInterval(maintenance); clearInterval(refreshTimer); clearTimeout(broadcastTimer);
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
