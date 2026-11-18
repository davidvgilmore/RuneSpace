# Songs of the Guild

RuneSpace includes three original compositions. They evoke the General MIDI orchestration and medieval fantasy mood of early online role-playing games. They do not quote RuneScape melodies or use RuneScape recordings or assets.

| Piece | Length | Character |
| --- | --- | --- |
| Lanterns at the Commons | 2:02 | A romantic Dorian air in 6/8, with flute, harp, lute, strings and answering oboe |
| Banners at Dawn | 2:07 | A broad minor-key procession with French horn calls, bowed strings and bells |
| The Willow Road | 2:02 | A bright Mixolydian walking tune for flute, lute and harp |

Each has a scored introduction, two contrasting melodic sections, return and cadence. The `.mid` files are standard format-1 MIDI; `.score.json` files preserve the note-level arrangements. Playback uses compact AAC renditions with a little hall reverb. The built-in macOS General MIDI sound bank is used during rendering, but is not copied or redistributed with this mod.

Regenerate the scores with `python3 scripts/music-compose.py`, compile `scripts/music-render.swift` using `swiftc -O`, then render each score to WAV and convert with `/usr/bin/afconvert -f m4af -d aac -b 128000 -q 127`. The renderer closes the WAV before conversion and reports peak/RMS levels. `python3 scripts/music-test.py` validates the MIDI and playback assets.

## Native playback

`control.py` is a small CLI for the Guild mod. It compiles `player.swift` into the mod’s local cache when the source changes. The player uses AVAudioPlayer, loops one selected track, and keeps its volume independent from the system volume. State is private to this mod. There is no network listener or Herdr binary change.

- `prepare`: compile without playing any sound.
- `update --playing true --active true --volume 0.30 --track lanterns`: play/resume. Omit unchanged options.
- `heartbeat --active true`: refresh the owner heartbeat about every five seconds.
- `heartbeat --active false`: pause immediately when the world is hidden.
- `update --playing false`: user pause, preserving the current position.
- `update --volume 0`: mute; use any value from 0 to 1 for volume.
- `update --track banners`: switch the selected piece. IDs are `lanterns`, `banners`, and `willow`.
- `status`: inspect requested and actual playback state.
- `stop`: stop and exit the mod’s own player.

The player pauses/exits if the owner heartbeat becomes older than 14 seconds. It exits after 15 seconds of inactivity and restores the saved position if resumed. An exclusive lock prevents duplicate players. The helper never terminates other apps or alters audio-device settings. `RUNESPACE_MUSIC_STATE` can select an isolated state directory for muted tests.
