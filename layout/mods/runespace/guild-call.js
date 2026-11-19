import { View, div } from 'gpui-kit';
import { h_flex, v_flex, Input, InputState } from 'gpui-base';
import { appHome, checking, closeOverlay, exec, openOverlay, readTextFile, run, setShared, shared, theme } from 'herdr';

const stateKey = 'runespace.callState';
const pausedKey = 'runespace.callPaused';
const busyKey = 'runespace.callAction';
const noteKey = 'runespace.callNote';

async function roomConfig() {
  const data = appHome() + '/data/';
  for (const [file, visiting] of [['runespace-visit.json', true], ['runespace-team.json', false]]) {
    try {
      const config = JSON.parse(await readTextFile(data + file));
      if (typeof config?.url !== 'string' || !config.url) continue;
      const hosting = !visiting && /(?:#|&)owner=[^&]+/.test(config.url);
      return {configured:true, hosting, visiting, shareAgents:hosting || config.shareAgents === true,
        displayName: typeof config.name === 'string' ? config.name.slice(0,32) : ''};
    } catch (_) { /* A fresh installation has no saved guild. */ }
  }
  return {configured:false};
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
        micPending: !!state.micPending, cameraPending: !!state.cameraPending,
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
  return job && Date.now() - job.at < (['start','join','return-home'].includes(job.action) ? 125000 : 15000) ? job.action : '';
}

async function control(mod, action, options) {
  const home = appHome();
  const result = await exec('/usr/bin/python3', [
    home + '/mods/' + mod + '/play/social.py', action, '--app-home', home,
    ...(action === 'join' ? ['--name=' + options.name, ...(options.shareAgents ? ['--bring-agents'] : []), ...(options.visit ? ['--visit'] : [])] : []),
  ], {timeout: ['start','join','return-home'].includes(action) ? 125000 : 10000});
  if (result.code !== 0) {
    let reason;
    try { reason = messageText(JSON.parse(result.stdout).error); } catch (_) {}
    throw Error(reason || 'The call could not complete that action. Try again.');
  }
}

function send(cx, mod, action, options) {
  if (pending()) return;
  const at = Date.now();
  setShared(busyKey, {action, at});
  setShared(noteKey, '');
  cx.spawn(async cx => {
    try {
      await control(mod, action, options);
      if (['stop','start','join','return-home'].includes(action)) setShared(pausedKey, action === 'stop');
      if (action === 'invite') setShared(noteKey, 'Guest invite copied to clipboard.');
      const config = await roomConfig();
      setShared(stateKey, {...await readState(), ...config});
      options?.onJoined?.();
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
    if (!(await roomConfig()).configured || shared(pausedKey) || pending()) return;
    const state = await readState();
    if (!state.connected && !shared(pausedKey) && !pending()) send(cx, mod, 'start');
  });
}

export function watchGuildCall(cx) {
  let reading = false;
  const refresh = cx => {
    if (reading) return;
    reading = true;
    cx.spawn(async cx => {
      try {
        const config = await roomConfig();
        const next = config.configured ? {...await readState(), ...config} : config;
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
      width: Math.max(1, Math.min(410, width - 24)), height: Math.max(1, Math.min(318, height - 24))});
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
    this.switching = false;
    this.bringAgents = false;
    this.name = InputState.new({placeholder:'Your name', value:shared(stateKey)?.displayName || ''});
    this.name.on('change', (_e, cx) => cx.notify());
    this.name.on('submit', (_e, cx) => {
      if (!(shared(stateKey) || {}).configured || this.switching) this.join(cx);
    });
    this.focus = cx.focus_handle();
    this.focus.focus();
  }
  join(cx) {
    const name = this.name.value().trim();
    if (!name) return;
    const room = shared(stateKey) || {};
    send(cx, this.mod, 'join', {name, shareAgents:this.bringAgents, visit:room.hosting || room.visiting,
      onJoined:() => this.enterWorld()});
  }
  enterWorld() {
    this.switching = false;
    closeOverlay(this.overlay);
    run(this.mod + '.world');
  }
  render() {
    const t = theme(), state = shared(stateKey) || {}, busy = pending();
    const connected = state.connected, names = state.names || [];
    const joined = connected || ['connecting', 'offline'].includes(state.status);
    const setup = state.configured === false || this.switching;
    const presence = {connecting: 'Joining the guild…', offline: 'Reconnecting…', stopped: 'Call ended'};
    const status = connected ? (names.length ? 'Here with you · ' + names.join(', ') : (state.displayName ? 'Here as ' + state.displayName : 'You are here'))
      : busy === 'start' ? 'Joining the guild…' : presence[state.status] || 'Disconnected';
    const starting = [state.micPending && !state.mic && 'microphone', state.cameraPending && !state.camera && 'camera'].filter(Boolean);
    const captureNote = starting.length ? 'Starting ' + starting.join(' and ') + '… Allow access if macOS asks.' : '';
    const note = state.error || captureNote || shared(noteKey) || state.message ||
      (connected && !state.mediaConnected ? 'Guild voice and video are unavailable.' : '');
    const command = (action, label, active = false, disabled = false) =>
      actionButton('call-' + action, label, (_e, cx) => send(cx, this.mod, action,
        action === 'return-home' ? {onJoined:() => this.enterWorld()} : undefined), active, disabled || !!busy);
    return v_flex().size_full().p(16).gap(10).bg(t.chrome).border(2).border_color(t.border)
      .track_focus(this.focus).key_context('RuneSpaceCall').on_key_down((event, cx) => {
        if (event.key.toLowerCase() === 'escape') {
          closeOverlay(this.overlay);
          cx.stop_propagation();
        }
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().font_family('Georgia').text_size(23).text_color(t.accent).child(setup ? 'Join a guild' : 'Guild call'))
        .child(actionButton('call-close', 'Close', () => closeOverlay(this.overlay))))
      .when(setup, el => el
        .child(div().text_size(13).text_color(t.foreground).child('Copy the invite from your teammate, then join with your display name.'))
        .child(Input.new(this.name).h(34).px(8).border_1().border_color(t.input).bg(t.background)
          .text_size(14).text_color(t.foreground).accessibility_label('Your display name'))
        .child(h_flex().gap(8).child(actionButton('call-bring-agents', this.bringAgents ? '✓ Bring my agents' : 'Bring my agents',
          (_e, cx) => { this.bringAgents = !this.bringAgents; cx.notify(); }, this.bringAgents, !!busy)))
        .child(div().text_size(12).text_color(t.muted).child('Share agent classes and activity. Chats stay on your Mac.'))
        .child(div().flex_1().text_size(12).text_color(t.muted).child(note))
        .child(h_flex().gap(8).justify_end()
          .when(this.switching, row => row.child(actionButton('call-cancel-join','Cancel',(_e,cx) => {
            this.switching = false; setShared(noteKey,''); cx.notify();
          },false,!!busy)))
          .child(actionButton('call-paste-join',busy === 'join' ? 'Joining…' : 'Join with copied invite',
            (_e,cx) => this.join(cx),true,!!busy || !this.name.value().trim()))))
      .when(!setup, el => el
        .child(div().truncate().text_size(14).text_color(connected ? t.working : t.muted).child(status))
        .when(!!state.configured, section => section.child(h_flex().gap(8)
          .child(command('mic', state.micPending ? 'Mic…' : state.mic ? 'Mic on' : 'Mic off',
            state.mic, !state.mediaConnected || state.micPending))
          .child(command('camera', state.cameraPending ? 'Camera…' : state.camera ? 'Camera on' : 'Camera off',
            state.camera, !state.mediaConnected || state.cameraPending))
          .when(!!state.audioBlocked, row => row.child(command('sound', 'Enable sound', false, !state.mediaConnected)))))
        .when(!!state.configured, section => section.child(h_flex().gap(8)
          .when(!state.hosting, row => row.child(command(state.shareAgents ? 'share-off' : 'share-on',
            state.shareAgents ? '✓ Sharing my agents' : 'Share my agents', state.shareAgents)))
          .when(state.visiting, row => row.child(command('return-home', 'Return to my guild')))
          .when(!joined && !state.visiting, row => row.child(actionButton('call-change-guild',state.hosting ? 'Visit another guild' : 'Join another guild',(_e,cx) => {
            this.switching = true; this.bringAgents = false; setShared(noteKey,''); cx.notify();
          },false,!!busy)))))
        .child(div().flex_1().text_size(12).text_color(t.muted).child(note))
        .when(!!state.configured, section => section.child(h_flex().justify_between().gap(8)
          .child(command('invite', 'Copy guest invite'))
          .child(joined ? command('stop', 'Leave call') : command('start', 'Join call', true)))));
  }
}
