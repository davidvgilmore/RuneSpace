import {execFile} from 'node:child_process';
import {createHash, timingSafeEqual} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {promisify} from 'node:util';
import {resolveAgentKey} from './agents.mjs';

const execute = promisify(execFile);
const digest = text => createHash('sha256').update(text).digest();
const fail = (status, message) => Object.assign(new Error(message), {status});

export function createHostActions(config, invite, rosterFile) {
  if (!config) return null;
  const {token, cli, mod} = config;
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || token === invite) {
    throw Error('Use a separate random RUNESPACE_OWNER_TOKEN of at least 32 characters.');
  }
  if (typeof cli !== 'string' || !isAbsolute(cli) || !['guild-hall', 'runespace'].includes(mod)) {
    throw Error('Set an absolute RUNESPACE_HERDR_CLI and a RUNESPACE_HERDR_MOD of guild-hall or runespace.');
  }
  const ownerHash = digest(token);
  const run = config.run || execute;
  const limits = {timeout:4000, maxBuffer:512 * 1024};
  let opening = false;

  async function desktop(action) {
    if (opening) throw fail(409, 'Herdr is opening a view. Try again in a moment.');
    opening = true;
    try {
      const status = await run(cli, ['status'], limits);
      if (JSON.parse(status.stdout).layout !== mod) throw fail(409, 'Select the configured guild layout on your Herdr desktop first.');
      const result = await run(cli, ['do', mod + '.' + action], limits);
      if (JSON.parse(result.stdout).ok !== true) throw Error('Command failed');
      if (process.platform === 'darwin') await run('/usr/bin/open', ['-b', 'dev.herdr.app'], limits);
    } catch (error) {
      if (error.status === 409) throw error;
      throw fail(503, 'Herdr could not open that view. Check the host desktop and try again.');
    } finally {
      opening = false;
    }
  }

  return {
    mod,
    authenticates(value) {
      return typeof value === 'string' && value.length <= 512 && timingSafeEqual(ownerHash, digest(value));
    },
    openWorld() { return desktop('world'); },
    async openChat(id) {
      const key = await resolveAgentKey(rosterFile, mod, id);
      if (!key) throw fail(404, 'This agent is no longer available in the host guild.');
      await desktop('select:' + key);
    },
  };
}
