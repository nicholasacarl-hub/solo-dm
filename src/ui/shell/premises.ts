/**
 * Original campaign premises for the New Campaign wizard's "Surprise me" button.
 * All names and places here are invented for Solo DM.
 */
import type { TonePresetId } from './campaignOptions';

export interface PremiseSeed {
  name: string;
  premise: string;
  tone: TonePresetId;
  setting: string;
  emoji: string;
  color: string;
}

export const PREMISES: readonly PremiseSeed[] = [
  {
    name: 'The Salt Choir',
    premise:
      'Every night at low tide, the drowned bells beneath Brinmoor harbor ring out a hymn no living priest wrote. The fishing fleet has stopped putting to sea, and the town council has paid you in advance to make the singing stop.',
    tone: 'cosmic',
    setting:
      'A rain-soaked fishing town on a cold northern coast. A chapel lies sunken beneath the harbor, and the old families won’t say why.',
    emoji: '🔔',
    color: '#4f8fd6',
  },
  {
    name: 'The Ninefold Crown',
    premise:
      'The old queen died without naming an heir, and nine claimants have nine days to win the Ember Council. One of them has asked you, a nobody, to be their champion, precisely because nobody would suspect you.',
    tone: 'intrigue',
    setting: 'A walled capital of canals and guild towers, where every vote has a price and every price has a broker.',
    emoji: '👑',
    color: '#c9a227',
  },
  {
    name: 'Cinderwake',
    premise:
      'A falling star struck the Ashen Weald a year ago, and the forest has burned ever since without being consumed. Now things are walking out of the flames, and they are asking for you by name.',
    tone: 'heroic',
    setting:
      'Logging towns and watchtowers on the edge of an endless smoldering forest, guarded by a dwindling company of rangers.',
    emoji: '☄️',
    color: '#e8a33d',
  },
  {
    name: 'The Wandering Isle',
    premise:
      'Your ship ran aground on an island that isn’t on any chart, and the island is moving. The crew is close to mutiny, the captain is missing, and the stars overhead are wrong.',
    tone: 'swashbuckling',
    setting: 'A sun-bleached archipelago of pirate havens, rival trading companies and a sea that keeps its own secrets.',
    emoji: '⛵',
    color: '#2f9e9a',
  },
  {
    name: 'The Bargain at Thistlewick',
    premise:
      'A fox in a velvet waistcoat has stolen your shadow and left a note: bring back three impossible things by midsummer, or never cast a shadow again.',
    tone: 'fairy-tale',
    setting: 'Sleepy villages, enchanted hedgerows and a wood where the animals keep courts, feasts and grudges.',
    emoji: '🦊',
    color: '#5fa35a',
  },
  {
    name: 'The Sealed Hold',
    premise:
      'The mountain hold of Karrak Dun sealed its gates a century ago. This morning they opened, and a single dwarf staggered out, begging for help against something that came up from below.',
    tone: 'grim',
    setting: 'Snowbound passes, abandoned mine roads and a vast underground city where the lamps went out long ago.',
    emoji: '⛏️',
    color: '#7d8796',
  },
  {
    name: 'Red Salt Road',
    premise:
      'Someone is murdering the caravan masters of the Red Salt Flats, one by one. You’ve signed on as a guard for the last caravan of the season, and the killer is riding with you.',
    tone: 'grim',
    setting: 'A blistering salt desert crossed by a single trade road, its waystations run by feuding merchant houses.',
    emoji: '🐪',
    color: '#d4544b',
  },
  {
    name: 'The Everflame Job',
    premise:
      'The thieves’ guild of Coldharbor has one initiation: steal the Everflame from the high temple before the solstice bells. Nobody has ever managed it. You need to.',
    tone: 'swashbuckling',
    setting:
      'A crowded port city of rooftops and smugglers’ tunnels, zealous temple wardens, and a guild that never forgets a debt.',
    emoji: '🕯️',
    color: '#d4699a',
  },
  {
    name: 'The Last Ferry',
    premise:
      'You wake on a ferry crossing a river of mist with no memory of boarding. The ferryman says you have until the far shore to remember who you were, and who killed you.',
    tone: 'cosmic',
    setting: 'A twilight borderland between life and death: drowned towns, lantern-lit waystations, and souls who want something from you.',
    emoji: '🌙',
    color: '#8b75e8',
  },
  {
    name: 'The Wolf Who Would Be King',
    premise:
      'The beasts of the Greywood have crowned a king: a great wolf with antlers for a crown, who means to drive the woodcutters out. The woodcutters want him dead. The wolf wants to talk to you.',
    tone: 'fairy-tale',
    setting: 'An ancient forest where animals speak the old tongue, ringed by hungry timber towns.',
    emoji: '🐺',
    color: '#2f9e9a',
  },
  {
    name: 'The Sunken Library',
    premise:
      'The sea has drawn back a mile from the cliffs of Varnel, revealing a library swallowed by the waves a thousand years ago. Scholars, looters and cultists are racing to its doors, and so are you.',
    tone: 'heroic',
    setting: 'Windswept cliffs, a boomtown of tents and treasure hunters, and a vast dripping library with guardians of its own.',
    emoji: '📚',
    color: '#4f8fd6',
  },
  {
    name: 'The Masked Vote',
    premise:
      'In the lagoon city of Valmire, the ruling council is chosen at a masked ball where no one may show their face. Someone plans to murder this year’s winner before dawn, and you’ve been hired to keep them alive without knowing who they are.',
    tone: 'intrigue',
    setting: 'A decadent city of masquerades, gondolas and noble houses older than the empire that claims them.',
    emoji: '🎭',
    color: '#8b75e8',
  },
];

/** A random premise, avoiding the one currently shown (UI flavor only, not game state). */
export function randomPremise(currentName?: string, random: () => number = Math.random): PremiseSeed {
  const pool = PREMISES.filter((p) => p.name !== currentName);
  return pool[Math.floor(random() * pool.length) % pool.length];
}
