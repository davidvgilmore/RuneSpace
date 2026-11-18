import test from 'node:test';
import assert from 'node:assert/strict';
import { trackPiTurns } from '../integrations/pi/turns.js';

test('older Pi reports interactive turns and clears the report on session switch', () => {
  const handlers = new Map(), reports = [];
  const title = 'Restock the forge';
  const pi = {on: (name, fn) => handlers.set(name, fn), getSessionName: () => title};
  trackPiTurns(pi, packet => reports.push(packet));
  const ctx = {hasUI: true, isIdle: () => true};
  handlers.get('session_start')({}, {...ctx, hasUI: false});
  assert.deepEqual(reports, []);
  handlers.get('session_start')({}, ctx);
  function turn(stopReason) {
    handlers.get('agent_start')({}, ctx);
    handlers.get('agent_end')({messages: [{role: 'assistant', stopReason}]}, ctx);
  }
  turn('stop');
  turn('error');
  turn('aborted');
  handlers.get('session_shutdown')({}, ctx);
  handlers.get('session_start')({}, {...ctx, isIdle: () => false});
  assert.deepEqual(reports.map(s => s.match(/state=(\w+)/)[1]),
    ['idle', 'working', 'done', 'working', 'error', 'working', 'idle', 'clear', 'working']);
  const field = Buffer.from(title).toString('base64');
  assert.equal(reports[0], '\x1b]7501;state=idle:app=pi:title=' + field + '\x1b\\');
});
