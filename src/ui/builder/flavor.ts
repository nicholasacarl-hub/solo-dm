/**
 * Original flavor tables for "Let the DM decide": names, alignments, personality prompts and
 * portrait emoji. Nothing here is copied from a published book.
 */
import type { Rng } from '@/engine';

export const ALIGNMENTS = [
  'Lawful Good',
  'Neutral Good',
  'Chaotic Good',
  'Lawful Neutral',
  'Neutral',
  'Chaotic Neutral',
  'Lawful Evil',
  'Neutral Evil',
  'Chaotic Evil',
] as const;

export const PORTRAITS = [
  '🧙', '🧙‍♀️', '🧝', '🧝‍♀️', '🧔', '👩‍🦰', '🧑‍🦱', '👨‍🦳', '👩‍🦳', '🧕', '👳', '🥷',
  '🤺', '🛡️', '⚔️', '🏹', '🗡️', '🪓', '🔮', '📜', '🎻', '🎭', '🐉', '🦊',
  '🐺', '🦉', '🐻', '🌙', '☀️', '🔥', '❄️', '⚡', '🌿', '🍄', '💀', '👑',
] as const;

const SPECIES_PORTRAIT: Record<string, string> = {
  dragonborn: '🐉',
  dwarf: '🧔',
  elf: '🧝',
  gnome: '🍄',
  goliath: '🗿',
  halfling: '🍀',
  human: '🧑',
  orc: '🪓',
  tiefling: '😈',
};

const NAMES: Record<string, string[]> = {
  dragonborn: ['Kethra Ashscale', 'Vorrin Emberclaw', 'Sabeth Coldflame', 'Draxan Hollowroar', 'Ilvara Brightwing'],
  dwarf: ['Dorna Ironvein', 'Brakka Stonehew', 'Hurlin Deepdelve', 'Tova Ambermantle', 'Kordan Blackanvil'],
  elf: ['Sariel Moonbrook', 'Thalion Ashgrove', 'Ilyra Windwhisper', 'Faelar Duskmere', 'Naeris Starfall'],
  gnome: ['Pip Tinkerwell', 'Nissa Copperkettle', 'Bimble Fernspark', 'Wenna Quickcog', 'Tobble Glimmerstone'],
  goliath: ['Kavra Stormpeak', 'Thune Highcairn', 'Mauga Frostridge', 'Orrun Skyreach', 'Leska Boulderborn'],
  halfling: ['Tilly Brambleford', 'Merric Underbough', 'Rosie Thistledown', 'Wendel Applebrook', 'Poppy Hearthfield'],
  human: ['Mara Holloway', 'Corwin Vale', 'Isolde Marsh', 'Tobin Ashford', 'Elsbeth Crane', 'Garran Reed'],
  orc: ['Ruka Ironhide', 'Grask Thornjaw', 'Varna Ashtusk', 'Durga Redmane', 'Holg Stonefist'],
  tiefling: ['Vesper', 'Calamity Thorne', 'Mercy Ashveil', 'Iskander Vey', 'Solace Nightbloom'],
};

const GENERIC_NAMES = ['Rowan Greycloak', 'Ash Wintervale', 'Sable Morrow', 'Quill Harrow', 'Wren Calloway'];

const TRAITS = [
  'I hum old marching songs when I am nervous.',
  'I name every weapon I carry and talk to them.',
  'I trust animals far more than people.',
  'I keep a ledger of every favor owed — to me and by me.',
  'I can never resist a dare, however foolish.',
  'I am quiet until I am certain, then I am immovable.',
];

const IDEALS = [
  'Freedom. Chains are meant to be broken.',
  'Honor. My word is my bond, even to my enemies.',
  'Curiosity. Every locked door hides a lesson.',
  'Protection. The weak deserve a shield.',
  'Ambition. I will be remembered.',
  'Balance. Every gift has a price, and I pay mine.',
];

const BONDS = [
  'I carry a letter I have never dared to open.',
  'My village burned; I will find who lit the fire.',
  'An old mentor saved my life. I owe them everything.',
  'I am searching for a sibling who vanished at sea.',
  'A temple took me in when no one else would.',
  'I swore an oath to a dying stranger.',
];

const FLAWS = [
  'I take on every burden alone, even when I should not.',
  'I cannot walk past a game of chance.',
  'I hold grudges like treasure.',
  'I lie when the truth is inconvenient.',
  'I believe I am always the smartest one in the room.',
  'Fear of the dark has followed me since childhood.',
];

export const DM_BACKSTORY = 'Let the DM decide: weave my past into the story as it unfolds.';

function pick<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng.next() * items.length))];
}

export function speciesKey(name: string | undefined): string {
  return (name ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
}

export function suggestName(speciesName: string | undefined, rng: Rng): string {
  return pick(NAMES[speciesKey(speciesName)] ?? GENERIC_NAMES, rng);
}

export function defaultPortrait(speciesName: string | undefined): string {
  return SPECIES_PORTRAIT[speciesKey(speciesName)] ?? '🧑';
}

export function suggestPersonality(rng: Rng): { traits: string; ideals: string; bonds: string; flaws: string } {
  return { traits: pick(TRAITS, rng), ideals: pick(IDEALS, rng), bonds: pick(BONDS, rng), flaws: pick(FLAWS, rng) };
}

export function suggestAlignment(rng: Rng): string {
  // The DM leans heroic: good and neutral alignments only.
  return pick(ALIGNMENTS.slice(0, 6), rng);
}

export { pick };
