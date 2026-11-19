import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createGuildMedia, nearbyIdentities} from './media.js';

test('approaching, staying near the boundary, and leaving use shared world coordinates', () => {
  const self = {id: 'me', x: 0, z: 0};
  const at = x => [self, {id: 'friend', x, z: 0}, {id: 'missing-location', x: null, z: 1}];
  let near = nearbyIdentities(self, at(6));
  assert.deepEqual([...near], ['friend']);
  near = nearbyIdentities(self, at(8), near);
  assert.deepEqual([...near], ['friend']);
  near = nearbyIdentities(self, at(8.1), near);
  assert.equal(near.size, 0);
  assert.equal(nearbyIdentities(self, at(7), near).size, 0);
  assert.equal(nearbyIdentities(null, at(0), near).size, 0);
});

function control() {
  return {querySelector: () => null, setAttribute(name, value) { this[name] = value; }};
}

test('joins with devices off and late browser permission results cannot restart a left room', async () => {
  const micButton = control(), cameraButton = control(), soundButton = control();
  const devices = [];
  let room, settleMic, stopped = false;
  class Room extends EventEmitter {
    constructor() {
      super();
      room = this;
      this.remoteParticipants = new Map();
      this.localParticipant = {identity: 'me', trackPublications: new Map(), setMicrophoneEnabled: () =>
        new Promise(resolve => { settleMic = () => resolve({track: {stop() { stopped = true; }}}); })};
    }
    async connect(url, token, options) { assert.deepEqual(options, {autoSubscribe: false}); }
    async disconnect(stopTracks) { assert.ok(stopTracks); }
  }
  const media = createGuildMedia({tiles: {}, micButton, cameraButton, soundButton,
    onDevices: status => devices.push(status), sdk: {Room, RoomEvent: {}}});
  assert.equal(micButton.disabled, true);
  await media.connect({url: 'wss://guild.example', token: 'test'});
  assert.equal(micButton['aria-pressed'], 'false');
  assert.equal(cameraButton['aria-pressed'], 'false');
  const pending = micButton.onclick();
  assert.ok(micButton.disabled);
  await media.disconnect();
  settleMic();
  await pending;
  assert.ok(stopped);
  assert.ok(cameraButton.disabled);
  assert.ok(soundButton.hidden);
  assert.deepEqual(devices, []);
  assert.deepEqual(room.eventNames(), []);
});

test('microphone permission stays pending independently while camera can publish and mute', async () => {
  const mic = control(), camera = control(), sound = control(), status = [];
  let rejectMic;
  class Room extends EventEmitter {
    constructor() {
      super();
      this.remoteParticipants = new Map();
      this.localParticipant = {
        identity:'me', trackPublications:new Map(),
        setMicrophoneEnabled:() => new Promise((_, reject) => { rejectMic = reject; }),
        async setCameraEnabled(enabled) { this.isCameraEnabled = enabled; },
      };
    }
    async connect() {}
    async disconnect() {}
  }
  const media = createGuildMedia({tiles:{}, micButton:mic, cameraButton:camera, soundButton:sound, native:true,
    sdk:{Room, RoomEvent:{}}, onStatus:(text, device) => status.push([device, text])});
  await media.connect({});
  const pending = mic.onclick();
  assert.equal(mic['aria-busy'], 'true');
  assert.equal(mic.disabled, true);
  assert.equal(camera.disabled, false);
  await camera.onclick();
  assert.equal(camera['aria-pressed'], 'true');
  await camera.onclick();
  assert.equal(camera['aria-pressed'], 'false');
  rejectMic(Object.assign(Error('Consent denied'), {name:'NotAllowedError'}));
  await pending;
  assert.equal(mic['aria-busy'], 'false');
  assert.equal(mic.disabled, false);
  assert.match(status.at(-1)[1], /Microphone access.*Privacy & Security/);
  assert.equal(status.at(-1)[0], 'mic');
  await media.disconnect();
});
