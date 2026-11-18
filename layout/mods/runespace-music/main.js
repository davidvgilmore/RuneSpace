import { View, div, image } from 'gpui-kit';
import { h_flex, v_flex, ScrollHandle } from 'gpui-base';
import { appHome, checking, closeOverlay, exec, props, readTextFile, theme } from 'herdr';
import { ALBUM_URL, TRACKS, clock } from './catalog.js';

const text = (value, size, color) => div().text_size(size).text_color(color).child(value);
const mono = (value, color) => text(value, 11, color).font_family('Menlo');
const blank = () => ({running: false, track: 1, playing: false, phase: 'stopped', elapsed: 0});
const close = () => closeOverlay(props().overlay);

async function control(action, track) {
  const home = appHome();
  const args = [home + '/mods/runespace/music/control.py', action, '--app-home', home];
  if (track) args.push('--track', String(track));
  const result = await exec('/usr/bin/python3', args, {timeout: action === 'status' ? 2500 : 150000});
  let reply;
  try { reply = JSON.parse(result.stdout); } catch (_) { /* A failed launch may have no stdout. */ }
  if (result.code !== 0 || !reply?.ok) throw Error(reply?.error || 'The soundtrack player could not respond. Try Play again.');
  return reply;
}

function button(id, title, label, onClick, primary = false) {
  const t = theme();
  return h_flex().id(id).role('button').accessibility_label(label).h(28).px(9).flex_shrink_0()
    .items_center().justify_center().bg(primary ? t.selected : t.raised)
    .border(1).border_color(primary ? t.idle : t.border)
    .cursor_pointer().hover(s => s.bg(t.hover)).on_click(onClick)
    .child(text(title, 13, primary ? t.accent : t.foreground));
}

export default class GuildMusic extends View {
  init(_props, cx) {
    this.station = blank();
    this.cursor = 1;
    this.scroll = ScrollHandle.new();
    this.focus = cx.focus_handle();
    this.focus.focus();
    this.width = 450;
    this.generation = 0;
    if (checking()) return;
    this.refresh(cx, true);
    cx.timer.every(900, cx => this.refresh(cx));
  }

  apply(reply) {
    const priorTrack = this.station.track;
    this.legacy = Boolean(reply?.running && reply.version !== 2);
    this.station = reply?.version === 2 && reply.running ? reply : blank();
    if (this.cursor === priorTrack && this.station.track !== priorTrack) {
      this.cursor = this.station.track;
      this.scroll.scroll_to_item(this.cursor - 1);
    }
  }

  refresh(cx, probe = false) {
    const check = probe || Date.now() - (this.lastCheck || 0) >= 15000;
    if (this.reading || this.sending || (!probe && !this.station.running && !(this.legacy && check))) return;
    this.reading = true;
    const generation = this.generation;
    cx.spawn(async cx => {
      try {
        // The lock-aware status command checks for stale state after a crash. Most
        // updates need only the compact local file, including the playback clock.
        let reply;
        if (check) {
          this.lastCheck = Date.now();
          reply = await control('status');
        } else {
          reply = JSON.parse(await readTextFile(appHome() + '/data/runespace-music/station-status.json'));
        }
        if (generation === this.generation) { this.apply(reply); cx.notify(); }
      } catch (_) {
        // The catalog stays available offline. A playback request reports errors.
      } finally { this.reading = false; }
    });
  }

  send(action, track, cx) {
    this.generation++;
    this.problem = '';
    this.intent = {action, track};
    if (track) { this.cursor = track; this.scroll.scroll_to_item(track - 1); }
    cx.notify();
    if (this.sending) return;
    this.sending = true;
    cx.spawn(async cx => {
      // If someone browses quickly while WebKit starts, the latest click wins.
      while (this.intent) {
        const next = this.intent;
        this.inFlight = next;
        this.intent = null;
        try {
          const reply = await control(next.action, next.track);
          if (!this.intent) this.apply(reply);
        } catch (error) {
          if (!this.intent) this.problem = error.message;
        }
      }
      this.inFlight = null;
      this.sending = false;
      cx.notify();
    });
  }

  track() { return this.intent?.track || this.inFlight?.track || this.station.track || 1; }

  toggle(cx) {
    const desired = this.intent || this.inFlight;
    if (this.legacy && !desired) { this.send('stop', null, cx); return; }
    const playing = desired ? desired.action === 'play' : this.station.playing;
    this.send(playing ? 'pause' : 'play', null, cx);
  }

  step(delta, cx) {
    const index = (this.track() - 1 + delta + TRACKS.length) % TRACKS.length;
    this.send('play', TRACKS[index].number, cx);
  }

  key(event, cx) {
    if (event.modifiers.platform || event.modifiers.control || event.modifiers.alt) return;
    const key = event.key.toLowerCase();
    if (key === 'up' || key === 'down') {
      this.cursor = Math.max(1, Math.min(TRACKS.length, this.cursor + (key === 'up' ? -1 : 1)));
      this.scroll.scroll_to_item(this.cursor - 1);
      cx.notify();
    } else if (['escape', 'm'].includes(key)) { if (!event.is_held) close(); }
    else if (key === 'enter') { if (!event.is_held) this.send('play', this.cursor, cx); }
    else if (key === 'space' || key === ' ') { if (!event.is_held) this.toggle(cx); }
    else return;
    cx.stop_propagation();
  }

  row(track, current) {
    const t = theme();
    const active = current === track.number;
    const highlighted = this.cursor === track.number;
    return h_flex().id('music-track-' + track.number).role('button')
      .accessibility_label('Play ' + track.title + ', ' + clock(track.duration))
      .h(31).flex_shrink_0().items_center().gap(10).px(11)
      .border_l(3).border_color(active ? t.accent : highlighted ? t.input : t.popover)
      .bg(active ? t.selected : highlighted ? t.raised : t.popover)
      .cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_event, cx) => this.send('play', track.number, cx))
      .child(mono(active && this.station.playing ? '▶' : String(track.number).padStart(2, '0'), active ? t.accent : t.dim).w(18))
      .child(text(track.title, 15, active ? t.accent : t.foreground).flex_1().min_w(0).truncate())
      .child(mono(clock(track.duration), active ? t.foreground : t.muted));
  }

  render() {
    const t = theme(), station = this.station;
    const track = TRACKS[this.track() - 1] || TRACKS[0];
    const pending = this.intent || this.inFlight;
    const playing = pending ? pending.action === 'play' : station.playing;
    const legacy = this.legacy && !pending;
    const seconds = track.number === station.track ? station.elapsed : 0;
    const error = this.problem || station.error;
    const state = error ? 'Playback unavailable' : legacy ? 'Previous player open' :
      pending || station.phase === 'loading' ? 'Tuning in…' :
      station.playing ? 'Now playing' : station.running ? 'Paused' : 'Ready to play';
    const trackWidth = Math.max(0, this.width - 44);
    const progress = Math.round(trackWidth * Math.min(1, (seconds || 0) / track.duration));
    const root = v_flex().id('runespace-music-player').size_full().min_w(0).min_h(0)
      .overflow_hidden().bg(t.chrome).border(2).border_color(t.border)
      .track_focus(this.focus).key_context('RuneSpaceMusic').on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((s, cx) => { if (s.width !== this.width) { this.width = s.width; cx.notify(); } });

    root.child(h_flex().h(59).px(12).gap(9).items_center().flex_shrink_0()
      .child(image('mods/runespace-music/lyre.png').w(39).h(39).flex_shrink_0())
      .child(v_flex().flex_1().min_w(0)
        .child(text('Music player', 23, t.accent).font_family('Georgia').truncate())
        .child(text('RuneScape · Original Soundtrack Classics', 12, t.muted).truncate()))
      .child(button('music-close', '×', 'Close music player', close)));

    const display = v_flex().bg(t.background || t.canvas).border(1).border_color(t.border)
      .px(11).py(9).gap(6).flex_shrink_0();
    display.child(h_flex().items_center().gap(8)
      .child(text(state, 12, error ? t.blocked : t.working).flex_1().min_w(0).truncate())
      .when(!legacy, row => row.child(mono(clock(seconds) + ' / ' + clock(track.duration), t.muted))));
    display.child(text(legacy ? 'Choose your next track' : track.title, 22, t.foreground).font_family('Georgia').truncate());
    if (!legacy) display.child(div().h(3).w_full().bg(t.raised).child(div().w(progress).h(3).bg(t.accent)));
    display.child(h_flex().items_center().gap(5)
      .when(!legacy, row => row.child(button('music-prev', '◀', 'Previous track', (_e, cx) => this.step(-1, cx))))
      .child(button('music-toggle', legacy ? 'Stop previous player' : playing ? 'Ⅱ  Pause' : '▶  Play',
        legacy ? 'Stop previous player' : playing ? 'Pause' : 'Play', (_e, cx) => this.toggle(cx), true))
      .when(!legacy, row => row.child(button('music-next', '▶', 'Next track', (_e, cx) => this.step(1, cx)))));
    if (error) display.child(text(String(error).slice(0, 220), 12, t.blocked).max_h(46).overflow_hidden());
    root.child(v_flex().px(8).flex_shrink_0().child(display));
    root.child(h_flex().h(31).px(12).items_center().justify_between().flex_shrink_0()
      .child(text('Track list', 14, t.foreground)).child(text(TRACKS.length + ' tracks', 12, t.muted)));
    root.child(v_flex().id('music-tracks').flex_1().min_h(0).mx(8)
      .bg(t.popover).border(1).border_color(t.border).overflow_y_scrollbar().track_scroll(this.scroll)
      .children(TRACKS.map(item => this.row(item, legacy ? null : track.number))));
    root.child(h_flex().h(34).px(12).items_center().gap(8).flex_shrink_0()
      .child(text('Jagex · Laced Records', 12, t.muted).flex_1().min_w(0).truncate())
      .child(div().id('music-bandcamp').role('button').accessibility_label('Open the official album on Bandcamp')
        .text_size(13).text_color(t.accent).cursor_pointer().hover(s => s.underline())
        .on_click((_event, cx) => cx.open_url(ALBUM_URL)).child('Bandcamp ↗')));
    return root;
  }
}
