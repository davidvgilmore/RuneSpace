// Older Pi releases expose turn events but do not publish terminal status.
import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { trackPiTurns } from './turns.js';

export default function runespaceStatus(pi: ExtensionAPI) {
  if (!process.env.HC_TERMINAL_ID || !process.stdout.isTTY) return;
  const [major, minor] = VERSION.split('.').map(Number);
  if (major > 1 || (major === 1 && minor >= 1)) return;
  trackPiTurns(pi, text => process.stdout.write(text));
}
