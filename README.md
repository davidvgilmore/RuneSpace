# RuneSpace

RuneSpace turns your Herdr agents into characters in a little medieval town. A working agent might swing a pick at the quarry or cast a line from the riverbank. Walk up to them and click to open their terminal. When they're ready for another task, look for them around the fire.

## Gameplay demo

Take a 52-second walk around the guild, open an agent's conversation, and return to the green.

https://github.com/user-attachments/assets/b9d74557-109c-4cc7-8af1-ad63f4224a7f

<details>
<summary>Guild world screenshot</summary>

![A crowned adventurer meets agent companions around the guild fire, with miners, blacksmiths and anglers working nearby.](docs/guild-world.png)

</details>

## Install on macOS

You'll need a Metal-capable Mac, a working Herdr Desktop and Core installation, Node.js 22 or later, Python 3, and the Xcode Command Line Tools for Swift. Tested with Herdr Desktop 0.1.16 and Core 0.1.21. [Herdr Desktop](https://github.com/herdrdev/herdr-app) · [Herdr Core](https://github.com/herdrdev/herdr-core)

```sh
git clone https://github.com/davidvgilmore/RuneSpace.git
cd RuneSpace
python3 scripts/install.py
```

With Herdr running, pick **RuneSpace** in the layout picker, then click **Guild world**. The first visit compiles the Metal renderer. You can also select the layout from a terminal.

```sh
herdr-app do layout.switch '{"name":"runespace"}'
```

The installer builds the world and places the mod, theme and layout in your Herdr app home. It uses `~/.config/herdr-app` by default and accepts `HERDR_APP_HOME` or `--app-home PATH`. Herdr itself updates through its usual channel. To update RuneSpace, run `git pull --ff-only` followed by `python3 scripts/install.py` in this checkout.

## Around town

| Action | Control |
| --- | --- |
| Walk | Click the ground or use the arrow keys |
| Orbit and tilt the camera | A / D to orbit, W / S to tilt |
| Zoom | Scroll wheel |
| Talk to an agent | Click their character, or press Enter near them |
| Open your inventory | I |
| Dance | G |
| Music | M |

Codex agents are mages, Claude agents are rangers, and Hermes is the guildmaster. OpenCode warriors carry a sword and kite shield. Pi druids wear moss-green robes and a linen hood. Both stow their gear to chop trees, mine ore, fish, work the forge, or rake an allotment. Idle agents gather at the commons. After 30 minutes idle they leave the map and appear offline in the friends list.

Open **Inventory** to change any of seven equipment slots. The 29 cosmetics include all six partyhat colours, dragon chainbody, Bandos tassets, abyssal whip, Elysian spirit shield and fire cape. The two-handed Armadyl godsword takes both hands.

Press **M** in the world or click **Music** to open the official 43-track *RuneScape: Original Soundtrack Classics* album. Hit **Play** for *Scape Main*, or scroll to a favourite like *Harmony* or *Sea Shanty 2*. Minimize the player and the music keeps going while you walk or chat. Playback streams from Bandcamp and needs an internet connection. [Soundtrack and listening guide](layout/mods/runespace/music/README.md)

## Connecting OpenCode and Pi

Open the interactive harness in a Herdr terminal, or start one with `hc run --bg opencode` or `hc run --bg pi`. Click its character to open that same terminal. Remote agents use the machine connections you've already set up in Herdr.

RuneSpace uses the harness's terminal status reports to tell when it is working. Pi 1.1 and newer and OpenCode builds with native program-status reporting work out of the box. An interactive harness without a report appears as **Unknown**. [Pi 1.1 release notes](https://github.com/earendil-works/pi/releases/tag/v1.1.0) · [OpenCode native reporting](https://github.com/anomalyco/opencode/pull/55172)

For Pi 0.80.2 or OpenCode 2.0.25's full TUI, install the matching reporter **on the machine running the harness**, then open a new interactive session. You can pass either name on its own. OpenCode's `mini` interface doesn't load this plugin.

```sh
python3 scripts/install-harness-status.py pi opencode
```

The installer writes a `runespace-status` extension under Pi's agent directory and a plugin of the same name under OpenCode's configuration directory. Both activate inside Herdr terminals. To remove one, delete its `runespace-status` directory.

## License and credits

RuneSpace's original code and artwork are available under the [MIT License](LICENSE).

RuneSpace is an independent fan-made Herdr mod inspired by the 2005–2009 RuneScape era. RuneScape is a trademark of Jagex. The world and character models were made for the mod. The screenshot shows a fictional roster.

The official soundtrack is © and ℗ 2018 Jagex Ltd., licensed to Laced Music Ltd. RuneSpace streams it through the official Bandcamp player. [Album and credits](https://runescape-ost.bandcamp.com/album/runescape-original-soundtrack-classics)

The bundled Pixelated MS Sans Serif typefaces are by lou and distributed under CC BY-SA 3.0. [Font credit and license](layout/mods/runespace/fonts/LICENSE-MSSansSerif.txt)
