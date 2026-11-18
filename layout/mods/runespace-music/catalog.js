// Album order and timings from Jagex and Laced Records' official Bandcamp release.
export const ALBUM_URL = 'https://runescape-ost.bandcamp.com/album/runescape-original-soundtrack-classics';

const album = [
  ['Scape Main', 200],
  ['Newbie Melody', 223],
  ['Harmony', 219],
  ['Autumn Voyage', 139],
  ['Yesteryear', 237],
  ['Flute Salad', 117],
  ['Barbarianism', 273],
  ['Al Kharid', 200],
  ['Sea Shanty 2', 127],
  ['Baroque', 128],
  ['Waterfall', 141],
  ['Nightfall', 226],
  ['Adventure', 154],
  ['Medieval', 238],
  ['Garden', 158],
  ['Still Night', 171],
  ['Fanfare', 139],
  ['Arrival', 99],
  ['Horizon', 201],
  ['Castlewars', 227],
  ['Scape Sad', 172],
  ['Crystal Sword', 171],
  ['Dark', 175],
  ['Book of Spells', 323],
  ['Fanfare 2', 116],
  ['Gnome Village', 83],
  ['Romper Chomper', 199],
  ['Lightness', 265],
  ['Village', 214],
  ['Cave Background', 260],
  ['Sad Meadow', 213],
  ['Monkey Madness', 234],
  ['Dogs of War', 346],
  ['Altar Ego', 264],
  ['Elven Mist', 229],
  ['Work Work Work', 315],
  ['Fe Fi Fo Fum', 193],
  ['Mudskipper Melody', 244],
  ['Gnomeball', 151],
  ['Chompy Hunt', 187],
  ['Harmony 2', 259],
  ['Home Sweet Home', 320],
  ['Background', 243],
];

export const TRACKS = album.map(([title, duration], index) => ({number: index + 1, title, duration}));

export function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
}
