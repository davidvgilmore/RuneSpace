// The desktop renderer owns input and draws the resulting call frames in Herdr.
// The WKWebView stays alive across local chats, inventory and terminal changes.
import {createGuildMedia} from './media.js';

const element = id => document.getElementById(id);
const tiles = element('tiles');
const mic = element('mic'), camera = element('camera'), sound = element('sound');
const bridge = window.webkit?.messageHandlers.guild;
const now = () => performance.now();
const frameWidth = 144, frameHeight = 81;
let config, session, socket, self, peers = [];
let guildAgents = [], guildStations = [], sharing = false;
let status = 'connecting', message = '', deviceError = '', mediaConnected = false, mediaBusy = false;
let retryAt = 0, mediaRetryAt = 0, joining = false, stopped = false;
let sequence = 0, sentPose = '', sentRoster = '', lastMove = 0, lastRoster = 0, lastRosterSent = 0;
let pose, lastTiles = 0, mediaGeneration = 0;
const can = document.createElement('canvas');
can.width = frameWidth; can.height = frameHeight;
const ctx = can.getContext('2d', {willReadFrequently:true});

const media = createGuildMedia({tiles, micButton:mic, cameraButton:camera, soundButton:sound, adaptiveStream:false,
  onStatus(text) {
    message = text;
    deviceError = /^(Allow |No |Camera|Microphone|Playback|Use HTTPS)/.test(text || '') ? text : '';
    if (text === 'Reconnecting voice and video…') mediaRetryAt = now() + 4000;
    if (text?.includes('disconnected')) { mediaConnected = false; mediaRetryAt = now() + 1500; }
  }
});

async function post(path, data, bearer) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const res = await fetch(path, {method:'POST', headers, body: data === undefined ? undefined : JSON.stringify(data)});
  if (!res.ok) throw Object.assign(Error('Guild request failed (' + res.status + ').'), {status:res.status});
  return res.json();
}

function resetMedia() {
  mediaGeneration++;
  mediaBusy = mediaConnected = false;
  media.setPositions(null, []);
  void media.disconnect().catch(() => {});
}

async function connectMedia() {
  if (mediaBusy || mediaConnected || !session?.media || status !== 'connected') return;
  const ticket = ++mediaGeneration;
  mediaBusy = true;
  try {
    const args = await post('/api/media', undefined, session.session);
    if (ticket !== mediaGeneration) return;
    const ok = await media.connect(args);
    if (ticket === mediaGeneration) mediaConnected = ok !== false;
  } catch {
    if (ticket === mediaGeneration) {
      message = 'Reconnecting guild voice and video…'; mediaRetryAt = now() + 4000;
    }
  } finally { if (ticket === mediaGeneration) mediaBusy = false; }
}

// Keep each desktop's own agents selectable through their private Herdr session.
function placeRoster(world) {
  const poses = new Map((world.scene || []).map(([id,x,z,yaw,activity,moving]) =>
    [id,{x,z,yaw,activity,moving}]));
  const local = new Map(Object.entries(world.ownAgentIds || {}).map(([key,id]) => [id,key]));
  guildAgents = [];
  guildStations = [];
  for (const agent of world.agents || []) {
    const pose = poses.get(agent.id);
    if (!pose) continue;
    if (local.has(agent.id) || agent.ownerId === world.self || (world.hostDesktop && agent.hostAgent)) {
      if (world.sharedStations && local.has(agent.id)) guildStations.push({id:local.get(agent.id),...pose});
    } else if (agent.ownerName) {
      guildAgents.push({id:agent.id,name:agent.name,kind:agent.kind,status:agent.status,ownerName:agent.ownerName,...pose});
    }
  }
}

function connectSocket() {
  const url = new URL('/presence', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({type:'hello',session:session.session}));
  ws.onmessage = ({data}) => {
    if (ws !== socket) return;
    let world; try {world = JSON.parse(data);} catch {return;}
    if (world.type !== 'world' || world.self !== session?.id || !Array.isArray(world.peers)) return;
    self = world.peers.find(p => p.id === world.self);
    peers = world.peers.filter(p => p.id !== world.self);
    if (!self) return;
    placeRoster(world);
    sequence = Math.max(sequence, self.seq || 0);
    status = 'connected';
    media.setPositions(self, peers);
    if (!mediaConnected && now() >= mediaRetryAt) void connectMedia();
  };
  ws.onclose = event => {
    if (ws !== socket || stopped) return;
    socket = null; self = null; peers = []; guildAgents = []; guildStations = []; sentPose = sentRoster = '';
    if (event.code === 1008 || event.code === 4001) session = null;
    resetMedia();
    status = 'connecting'; message = 'Reconnecting to the guild…'; retryAt = now() + 1000;
  };
}

async function join() {
  if (joining || stopped || !config || socket) return;
  joining = true;
  try {
    if (!session) {
      const occupy = pose && {x:pose.x,z:pose.z,yaw:pose.yaw};
      session = await post('/api/join', {name:config.name,invite:config.invite,owner:config.owner,
        client:'herdr',position:occupy,contributorKey:config.contributorKey,shareAgents:sharing});
    }
    if (!stopped) {message = session.media ? '' : 'This guild has presence only. Voice and video are unavailable.'; connectSocket();}
  } catch (error) {
    status = 'offline';
    message = error.status === 403 ? 'The guild invitation expired. Update the desktop invite to reconnect.' : 'The guild is unavailable. Retrying…';
    retryAt = now() + (error.status === 403 ? 15000 : 2500);
  } finally {joining = false;}
}

function sendPosition(time) {
  if (!self || !pose || socket?.readyState !== WebSocket.OPEN || time - lastMove < 85) return;
  if (Number.isFinite(pose.x) && Number.isFinite(pose.z) && Number.isFinite(pose.yaw)) {
    const move = {type:'move',x:pose.x,z:pose.z,yaw:pose.yaw,activity:pose.activity||'idle',moving:!!pose.moving,loadout:pose.loadout};
    const key = JSON.stringify(move);
    if (sentPose !== key || Math.hypot(self.x - pose.x,self.z - pose.z) > .2) {
      socket.send(JSON.stringify({...move,seq:++sequence})); sentPose = key; lastMove = time;
    }
  }

}

function sendRoster(time) {
  if (!self || socket?.readyState !== WebSocket.OPEN || time-lastRoster < 250) return;
  const fresh = Number.isFinite(pose?.sceneAt) && Math.abs(Date.now()/1000-pose.sceneAt) <= 7;
  const agents = sharing && Array.isArray(pose?.roster) ? pose.roster : [];
  const scene = sharing && fresh && Array.isArray(pose?.agents) ? pose.agents : [];
  const data = JSON.stringify({type:'roster',sharing,agents,scene});
  if (data !== sentRoster || (sharing && time-lastRosterSent >= 3000)) {
    socket.send(data);
    sentRoster = data;
    lastRosterSent = time;
  }
  lastRoster = time;
}

function encodePixels(bytes) {
  const pixels = new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (pixels.toBase64) return pixels.toBase64();
  let data = '';
  for (let i=0;i<pixels.length;i+=4096) data+=String.fromCharCode(...pixels.subarray(i,i+4096));
  return btoa(data);
}

function sampleTiles(time) {
  const sample = time - lastTiles >= 120;
  if (sample) lastTiles = time;
  const result = [];
  for (const node of Array.from(tiles.children).slice(0,8)) {
    const video = node.querySelector('video');
    const frame = {id:node.dataset.identity,name:node.querySelector('.media-name')?.textContent||'Teammate',
      local:node.dataset.local === 'true', speaking:node.dataset.speaking === 'true',
      video:!!video, width:frameWidth, height:frameHeight};
    if (sample && ctx && video?.readyState >= 2 && video.videoWidth > 0) {
      try {
        ctx.drawImage(video,0,0,frameWidth,frameHeight);
        ctx.fillStyle = 'rgba(12, 16, 17, .82)';
        ctx.fillRect(0,frameHeight-16,frameWidth,16);
        ctx.fillStyle = '#fff4d4'; ctx.font = 'bold 11px -apple-system,sans-serif';
        ctx.fillText(frame.name,4,frameHeight-4,frameWidth-8);
        frame.pixels = encodePixels(ctx.getImageData(0,0,frameWidth,frameHeight).data);
      } catch { /* An individual track may stop during a sample. */ }
    }
    result.push(frame);
  }
  return result;
}

window.runespaceSocial = {
  start(settings) {
    if (!config) {config = settings; sharing = settings.shareAgents === true; pose = settings.position; void join();}
  },
  step(position, command, shareAgents) {
    if (typeof shareAgents === 'boolean') sharing = shareAgents;
    if (position) pose = position;
    const time = now();
    if (!socket && time >= retryAt) void join();
    if (status === 'connected' && time >= mediaRetryAt) void connectMedia();
    sendPosition(time);
    sendRoster(time);
    if (command && ['mic','camera','sound'].includes(command)) {
      const button = element(command);
      if (mediaConnected && !button.disabled) button.click();
      else message = 'Voice and video are still connecting.';
    }
    return {status,connected:status==='connected',self:self?.id||null,peers,guildAgents,guildStations,mediaConnected,
      mic:mic.getAttribute('aria-pressed')==='true', camera:camera.getAttribute('aria-pressed')==='true',
      audioBlocked:!sound.hidden, message, error:status==='offline'?message:deviceError, tiles:sampleTiles(time)};
  },
  async stop() {
    stopped = true;status = 'offline';
    const old = session;session = null;
    if (socket) {socket.onclose = null;socket.close();socket = null;}
    await media.disconnect().catch(() => {});
    if (old) await post('/api/leave',undefined,old.session).catch(() => {});
  }
};
bridge?.postMessage('ready');
