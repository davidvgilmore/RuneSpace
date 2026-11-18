export function trackPiTurns(pi, write) {
  let last = '';
  function report(state, ctx) {
    if (!ctx.hasUI) return;
    const title = (pi.getSessionName() || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
    const field = state !== 'clear' && title ? ':title=' + Buffer.from([...title].slice(0, 128).join('')).toString('base64') : '';
    const packet = '\x1b]7501;state=' + state + ':app=pi' + field + '\x1b\\';
    if (packet !== last) write(packet);
    last = packet;
  }
  pi.on('session_start', (_event, ctx) => report(ctx.isIdle() ? 'idle' : 'working', ctx));
  pi.on('agent_start', (_event, ctx) => report('working', ctx));
  pi.on('agent_end', (event, ctx) => {
    const reply = event.messages.findLast(message => message.role === 'assistant');
    const reason = reply?.stopReason;
    report(reason === 'error' ? 'error' : reason === 'aborted' ? 'idle' : 'done', ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => report('clear', ctx));
}
