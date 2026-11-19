import { View, div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { appHome, checking, closeOverlay, exec, openOverlay, readTextFile, setShared, shared, theme } from 'herdr';

const stateKey = 'runespace.callState';
const pausedKey = 'runespace.callPaused';
const busyKey = 'runespace.callAction';
const noteKey = 'runespace.callNote';

async function configured() {
  try {
    const config = JSON.parse(await readTextFile(appHome() + '/data/runespace-team.json'));
    return Boolean(config?.url);
  } catch (_) { return false; }
}

function messageText(value) {
  return String(value || '').replace(/https?:\/\/\S+/gi, '').slice(0, 160);
}

async function readState() {
  try {
    const state = JSON.parse(await readTextFile(appHome() + '/data/runespace-social/state.json'));
    if (Math.abs(Date.now() / 1000 - Number(state.updatedAt)) < 10) {
      return {
        connected: !!state.connected, mediaConnected: !!state.mediaConnected, mic: !!state.mic, camera: !!state.camera,
        status: String(state.status || ''), audioBlocked: !!state.audioBlocked,
        names: (Array.isArray(state.peers) ? state.peers : []).map(p => String(p.name || 'Guest').slice(0, 32)),
        error: messageText(state.error), message: state.mediaConnected ? '' : messageText(state.message),
      };
    }
  } catch (_) { /* State appears when the helper first connects. */ }
  return {};
}

function pending() {
  const job = shared(busyKey);
  return job && Date.now() - job.at < (job.action === 'start' ? 125000 : 15000) ? job.action : '';
}

async function control(mod, action) {
  const home = appHome();
  const result = await exec('/usr/bin/python3', [
    home + '/mods/' + mod + '/play/social.py', action, '--app-home', home,
  ], {timeout: action === 'start' ? 120000 : 10000});
  if (result.code !== 0) {
    let reason;
    try { reason = messageText(JSON.parse(result.stdout).error); } catch (_) {}
    throw Error(reason || 'The call could not complete that action. Try again.');
  }
}

function send(cx, mod, action) {
  if (pending()) return;
  const at = Date.now();
  setShared(busyKey, {action, at});
  setShared(noteKey, '');
  cx.spawn(async cx => {
    try {
      await control(mod, action);
      if (action === 'stop' || action === 'start') setShared(pausedKey, action === 'stop');
      if (action === 'invite') setShared(noteKey, 'Guest invite copied to clipboard.');
      const state = await readState();
      setShared(stateKey, {...state, configured: true});
    } catch (error) {
      setShared(noteKey, error.message || 'Could not reach the call.');
    } finally {
      if (shared(busyKey)?.at === at) setShared(busyKey, null);
      cx.notify();
    }
  });
}

// A call outlives the embedded presenter. Changing panes or entering an agent's
// chat should neither disconnect the wearer nor re-enable devices they muted.
export function enterGuildCall(cx, mod) {
  if (checking()) return;
  cx.spawn(async cx => {
    if (!await configured() || shared(pausedKey) || pending()) return;
    const state = await readState();
    if (!state.connected && !shared(pausedKey) && !pending()) send(cx, mod, 'start');
  });
}

export function watchGuildCall(cx) {
  let reading = false, ready = false, checkedAt = 0;
  const refresh = cx => {
    if (reading) return;
    reading = true;
    cx.spawn(async cx => {
      try {
        if (Date.now() - checkedAt > 12000) {
          ready = await configured();
          checkedAt = Date.now();
        }
        const next = ready ? {...await readState(), configured: true} : {configured: false};
        if (JSON.stringify(next) !== JSON.stringify(shared(stateKey))) {
          setShared(stateKey, next);
          cx.notify();
        }
      } finally { reading = false; }
    });
  };
  refresh(cx);
  cx.timer.every(1400, refresh);
}

export function callButton(makeButton, mod) {
  const state = shared(stateKey) || {};
  const live = [state.mic && 'Mic', state.camera && 'Camera'].filter(Boolean).join(' + ');
  const peers = state.connected ? state.names?.length : 0;
  return makeButton('guild-call', live ? 'Call · ' + live : peers ? 'Call · ' + (peers + 1) : 'Call', () => {
    const {width, height} = window.viewport_size();
    openOverlay({mod, props: {role: 'call'}, kind: 'dialog', frame: 'none',
      width: Math.max(1, Math.min(354, width - 24)), height: Math.max(1, Math.min(242, height - 24))});
  }, !!live).role('button').accessibility_label('Guild call controls' + (live ? ', ' + live + ' on' : ''));
}

function actionButton(id, title, onClick, active = false, disabled = false) {
  const t = theme();
  const button = h_flex().id(id).role('button').accessibility_label(title).h(30).px(10)
    .items_center().justify_center().bg(active ? t.selected : t.raised)
    .border(1).border_color(t.border).text_size(13).text_color(disabled ? t.muted : active ? t.accent : t.foreground)
    .child(title);
  return disabled ? button : button.cursor_pointer().hover(s => s.bg(t.hover)).on_click(onClick);
}

export class GuildCall extends View {
  init(p, cx) {
    this.mod = p.mod;
    this.overlay = p.overlay;
    this.focus = cx.focus_handle();
    this.focus.focus();
  }
  render() {
    const t = theme(), state = shared(stateKey) || {}, busy = pending();
    const connected = state.connected, names = state.names || [];
    const joined = connected || ['connecting', 'offline'].includes(state.status);
    const presence = {connecting: 'Joining the guild…', offline: 'Reconnecting…', stopped: 'Call ended'};
    const status = connected ? (names.length ? 'Here with you · ' + names.join(', ') : 'You are here')
      : busy === 'start' ? 'Joining the guild…' : presence[state.status] || 'Disconnected';
    const note = state.error || shared(noteKey) || state.message ||
      (connected && !state.mediaConnected ? 'Guild voice and video are unavailable.' :
        state.configured ? '' : 'Configure a team room to invite people to your guild.');
    const command = (action, label, active = false, disabled = false) =>
      actionButton('call-' + action, label, (_e, cx) => send(cx, this.mod, action), active, disabled || !!busy);
    return v_flex().size_full().p(16).gap(10).bg(t.chrome).border(2).border_color(t.border)
      .track_focus(this.focus).key_context('RuneSpaceCall').on_key_down((event, cx) => {
        if (event.key.toLowerCase() === 'escape') {
          closeOverlay(this.overlay);
          cx.stop_propagation();
        }
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_family('Georgia').text_size(23).text_color(t.accent).child('Guild call'))
        .child(actionButton('call-close', 'Close', () => closeOverlay(this.overlay))))
      .child(div().truncate().text_size(14).text_color(connected ? t.working : t.muted).child(status))
      .when(!!state.configured, el => el.child(h_flex().gap(8)
        .child(command('mic', state.mic ? 'Mic on' : 'Mic off', state.mic, !state.mediaConnected))
        .child(command('camera', state.camera ? 'Camera on' : 'Camera off', state.camera, !state.mediaConnected))
        .when(!!state.audioBlocked, row => row.child(command('sound', 'Enable sound', false, !state.mediaConnected)))))
      .child(div().flex_1().text_size(12).text_color(t.muted).child(note))
      .when(!!state.configured, el => el.child(h_flex().justify_between().gap(8)
        .child(command('invite', 'Copy guest invite'))
        .child(joined
          ? command('stop', 'Leave call') : command('start', 'Join call', true))));
  }
}
