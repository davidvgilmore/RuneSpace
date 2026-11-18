# RuneSpace

RuneSpace turns your Herdr agents into characters in a little medieval town. A working agent might swing a pick at the quarry or cast a line from the riverbank. Walk up to them and click to open their terminal. When they're ready for another task, look for them around the fire.

![A crowned adventurer meets agent companions around the guild fire, with miners, blacksmiths and anglers working nearby.](docs/guild-world.png)

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

Codex agents wear mage robes, Claude agents are rangers, and OpenCode agents are warriors. Working characters chop trees, mine ore, fish, work the forge, or rake an allotment. After 30 minutes idle they leave the map and appear offline in the friends list. RuneSpace reads the agents and machines already connected to your Herdr instance.

Open **Inventory** to change any of seven equipment slots. The 29 cosmetics include all six partyhat colours, dragon chainbody, Bandos tassets, abyssal whip, Elysian spirit shield and fire cape. The two-handed Armadyl godsword takes both hands.

The music panel has three original pieces, including *Lanterns at the Commons* and *Banners at Dawn*. Music carries on when you enter a conversation. The MIDI scores, recordings and rendering notes are included. [Songs of the Guild](layout/mods/runespace/music/README.md)

## Credits

RuneSpace is an independent fan-made Herdr mod inspired by the 2005–2009 RuneScape era. RuneScape is a trademark of Jagex. The world, character models and soundtrack were made for the mod. The screenshot shows a fictional roster.

The bundled Pixelated MS Sans Serif typefaces are by lou and distributed under CC BY-SA 3.0. [Font credit and license](layout/mods/runespace/fonts/LICENSE-MSSansSerif.txt)
