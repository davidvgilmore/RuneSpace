import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readRoster} from './agents.mjs';

test('only fresh, visible pseudonymous guild characters leave the host', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'runespace-roster-'));
  t.after(() => rm(folder, {recursive:true, force:true}));
  const file = join(folder, 'roster.json');
  const agent = {key:'private-key', name:'private conversation', kind:'Codex', status:'working', cwd:'/private', mapVisible:true};
  const now = Date.now() / 1000;
  const save = data => writeFile(file, JSON.stringify(data));
  await save({'guild.snapshot': {at:now, agents:[agent, {...agent, key:'off', mapVisible:false}, {...agent, key:'mystery',kind:'private-program',status:'idle'}]}});
  const entries = await readRoster(file);
  assert.equal(entries.length, 2);
  assert.ok(entries.some(a => a.name === 'Codex mage 1' && a.status === 'working'));
  assert.ok(entries.some(a => a.name === 'Agent adventurer 1'));
  assert.ok(!JSON.stringify(entries).includes('private'));
  assert.deepEqual(await readRoster(file), entries);
  await save({at:now-100, agents:[agent]});
  assert.deepEqual(await readRoster(file), []);
});
