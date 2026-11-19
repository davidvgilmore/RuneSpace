// Human media only. The world server gives each presence session the same
// identity as its signed LiveKit token. Walking affects track subscriptions.
export function nearbyIdentities(self, peers, previous = new Set()) {
  const result = new Set();
  if (!Number.isFinite(self?.x) || !Number.isFinite(self?.z)) return result;
  for (const peer of peers) {
    if (!peer.id || peer.id === self.id || !Number.isFinite(peer.x) || !Number.isFinite(peer.z)) continue;
    const radius = previous.has(peer.id) ? 8 : 6;
    if (Math.hypot(peer.x - self.x, peer.z - self.z) <= radius) result.add(peer.id);
  }
  return result;
}

function label(button, text) {
  const target = button.querySelector('[data-media-label]') ?? button;
  if (target.textContent !== text) target.textContent = text;
}

function deviceFailure(error, device) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return 'Allow ' + device.toLowerCase() + ' access in your browser, then try again.';
  }
  if (error?.name === 'NotFoundError') return 'No ' + device.toLowerCase() + ' was found.';
  return device + ' could not start. Check your device and try again.';
}

export function createGuildMedia({tiles, micButton, cameraButton, soundButton, onStatus = () => {}, onDevices = () => {}, sdk}) {
  const doc = tiles.ownerDocument;
  const controls = [[micButton, 'mic', 'Mic'], [cameraButton, 'camera', 'Camera']];
  let active = null;
  let nearby = new Set();
  let names = new Map();
  let lastMic = false, lastCamera = false;
  const participants = new Map();

  function updateControls() {
    const local = active?.room.localParticipant;
    const mic = !!local?.isMicrophoneEnabled, camera = !!local?.isCameraEnabled;
    for (const [button, key, title] of controls) {
      const enabled = key === 'mic' ? mic : camera;
      button.disabled = !active?.connected || active.pending.has(key);
      button.setAttribute('aria-pressed', String(enabled));
      button.title = (enabled ? 'Turn off ' : 'Turn on ') + (key === 'mic' ? 'microphone' : 'camera');
      label(button, title + (enabled ? ' on' : ' off'));
    }
    soundButton.hidden = !active?.connected || (active.room.canPlaybackAudio !== false && active.room.canPlaybackVideo !== false);
    if (mic !== lastMic || camera !== lastCamera) {
      lastMic = mic; lastCamera = camera;
      onDevices({mic, camera});
    }
  }

  function clearTrack(tile, track, element) {
    track.detach(element);
    element.remove();
    tile.tracks.delete(track);
  }

  function clearTile(id, tile) {
    for (const [track, element] of tile.tracks) clearTrack(tile, track, element);
    tile.node.remove();
    participants.delete(id);
  }

  function syncParticipant(participant, local, visible) {
    const tracks = new Set();
    for (const publication of participant.trackPublications.values()) {
      const camera = publication.source === 'camera';
      const microphone = publication.source === 'microphone';
      if (!local) {
        const subscribe = visible && (camera || microphone);
        if (publication.isDesired !== subscribe) publication.setSubscribed(subscribe);
      }
      if (visible && publication.track && !publication.isMuted && (camera || (!local && microphone))) {
        tracks.add(publication.track);
      }
    }
    const id = participant.identity;
    let tile = participants.get(id);
    if (!tracks.size) {
      if (tile) clearTile(id, tile);
      return;
    }
    if (!tile) {
      const node = doc.createElement('article'), caption = doc.createElement('span');
      node.className = 'media-tile'; node.dataset.local = String(local);
      caption.className = 'media-name'; node.append(caption); tiles.append(node);
      tile = {node, caption, tracks: new Map()};
      participants.set(id, tile);
    }
    tile.caption.textContent = local ? 'You' : names.get(id) || participant.name || 'Teammate';
    tile.node.dataset.speaking = String(!!participant.isSpeaking);
    tile.node.dataset.camera = String([...tracks].some(track => track.kind === 'video'));
    for (const [track, element] of tile.tracks) {
      if (!tracks.has(track)) clearTrack(tile, track, element);
    }
    for (const track of tracks) {
      if (tile.tracks.has(track)) continue;
      const video = track.kind === 'video';
      const element = doc.createElement(video ? 'video' : 'audio');
      element.autoplay = true; element.playsInline = true; element.muted = video;
      element.hidden = !video;
      tile.node.insertBefore(element, tile.caption);
      track.attach(element);
      tile.tracks.set(track, element);
    }
  }

  function refresh() {
    if (active?.connected) {
      const {room} = active;
      syncParticipant(room.localParticipant, true, true);
      for (const person of room.remoteParticipants.values()) {
        syncParticipant(person, false, nearby.has(person.identity));
      }
      for (const [id, tile] of participants) {
        if (id !== room.localParticipant.identity && !room.remoteParticipants.has(id)) clearTile(id, tile);
      }
    }
    updateControls();
  }

  function setProximity(ids) {
    const next = new Set(ids);
    if (next.size === nearby.size && [...next].every(id => nearby.has(id))) return;
    nearby = next;
    refresh();
  }

  function setPositions(self, peers) {
    names = new Map(peers.map(peer => [peer.id, peer.name]));
    setProximity(nearbyIdentities(self, peers, nearby));
  }

  function retire(connection) {
    if (connection !== active) return;
    active = null;
    for (const [event, handler] of connection.handlers) connection.room.off(event, handler);
    for (const [id, tile] of participants) clearTile(id, tile);
    updateControls();
  }

  async function disconnect() {
    nearby = new Set(); names.clear();
    if (!active) return;
    const connection = active;
    retire(connection);
    await connection.room.disconnect(true);
  }

  async function connect({url, token}) {
    const api = sdk ?? globalThis.LivekitClient;
    if (!api?.Room) throw new Error('The LiveKit browser client could not load. Refresh this page to try again.');
    if (active) {
      const old = active;
      retire(old);
      void old.room.disconnect(true).catch(() => {});
    }
    const room = new api.Room({
      adaptiveStream: true, dynacast: true, publishDefaults: {stopMicTrackOnMute: true},
      videoCaptureDefaults: {resolution: {width: 640, height: 360, frameRate: 20}}
    });
    const connection = {room, connected: false, pending: new Set(), handlers: []};
    active = connection;
    function listen(event, action) {
      const name = api.RoomEvent[event];
      if (!name) return;
      const handler = (...args) => { if (active === connection) action(...args); };
      connection.handlers.push([name, handler]);
      room.on(name, handler);
    }
    for (const event of ['ParticipantConnected', 'ParticipantDisconnected', 'TrackPublished', 'TrackUnpublished',
      'TrackSubscribed', 'TrackMuted', 'TrackUnmuted', 'ActiveSpeakersChanged',
      'LocalTrackPublished', 'LocalTrackUnpublished', 'ParticipantNameChanged', 'AudioPlaybackStatusChanged',
      'VideoPlaybackStatusChanged']) listen(event, refresh);
    // LiveKit emits this event while clearing the previous publication track.
    listen('TrackUnsubscribed', () => queueMicrotask(() => { if (active === connection) refresh(); }));
    function reconnected() {
      connection.connected = true;
      onStatus(''); refresh();
    }
    function reconnecting() {
      connection.connected = false;
      for (const [id, tile] of participants) if (id !== room.localParticipant.identity) clearTile(id, tile);
      onStatus('Reconnecting voice and video…'); updateControls();
    }
    listen('Reconnecting', reconnecting);
    listen('SignalReconnecting', reconnecting);
    listen('Reconnected', reconnected);
    listen('Disconnected', () => {
      retire(connection);
      onStatus('Voice and video disconnected. Rejoin to reconnect.');
    });
    updateControls();
    try {
      await room.connect(url, token, {autoSubscribe: false});
      if (active !== connection) { await room.disconnect(true); return false; }
      reconnected();
      return true;
    } catch {
      const current = active === connection;
      retire(connection);
      await room.disconnect(true);
      if (!current) return false;
      throw new Error('Could not connect to voice and video. Check the media server and try again.');
    }
  }

  async function toggle(key) {
    const connection = active;
    if (!connection?.connected || connection.pending.has(key)) return;
    const local = connection.room.localParticipant;
    const mic = key === 'mic', enabled = mic ? local.isMicrophoneEnabled : local.isCameraEnabled;
    if (!enabled && globalThis.isSecureContext === false) { onStatus('Use HTTPS or localhost to enable your mic and camera.'); return; }
    connection.pending.add(key); updateControls();
    try {
      const pub = mic ? await local.setMicrophoneEnabled(!enabled) : await local.setCameraEnabled(!enabled);
      if (active !== connection) {
        // A browser permission prompt can resolve after leaving the room.
        pub?.track?.stop();
        return;
      }
      onStatus('');
    } catch (err) {
      if (active === connection) onStatus(deviceFailure(err, mic ? 'Microphone' : 'Camera'));
    } finally {
      connection.pending.delete(key);
      if (active === connection) refresh();
    }
  }

  micButton.onclick = () => toggle('mic');
  cameraButton.onclick = () => toggle('camera');
  soundButton.onclick = async () => {
    const connection = active;
    if (!connection?.connected) return;
    try {
      const room = connection.room;
      const starts = [];
      if (!room.canPlaybackAudio) starts.push(room.startAudio());
      if (room.canPlaybackVideo === false) starts.push(room.startVideo());
      await Promise.all(starts);
    } catch {
      if (active === connection) onStatus('Playback is blocked. Enable sound for this site and try again.');
    } finally { updateControls(); }
  };
  updateControls();
  return {connect, disconnect, setPositions, setProximity};
}
