/**
 * Sample data for tests and dev previews. Values follow the 2024 rules.
 */
import type {
  BattleMap,
  Campaign,
  CampaignSettings,
  Character,
  Clock,
  CombatState,
  JournalEntry,
  LogEntry,
  Quest,
  Session,
  UsageTotals,
} from '@/types';

export const zeroUsage = (): UsageTotals => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
});

export const sampleSettings = (): CampaignSettings => ({
  tone: 'Heroic fantasy with a streak of mystery',
  setting: 'A coastal frontier town built over drowned ruins.',
  rulesFidelity: 'balanced',
  homebrewFreedom: 'moderate',
  difficulty: 'standard',
  narrationLength: 'standard',
  playerRollMode: 'prompt',
  showDmRolls: false,
  milestoneLeveling: true,
  enabledSources: ['srd-5.2.1'],
  lines: ['Harm to children'],
  veils: ['Torture'],
  playerNotes: 'I love puzzles and talking my way out of trouble.',
});

export const sampleCampaign = (overrides: Partial<Campaign> = {}): Campaign => ({
  id: 'camp-1',
  name: 'The Drowned Lantern',
  premise: 'A lighthouse keeper vanished the night the old lantern lit itself.',
  characterId: 'char-1',
  settings: sampleSettings(),
  status: 'active',
  scene: { location: 'Saltmarsh Docks', timeOfDay: 'dusk', weather: 'fog rolling in', mood: 'uneasy' },
  sessionCount: 1,
  activeSessionId: 'sess-1',
  coverEmoji: '🏮',
  coverColor: '#e8a33d',
  tension: 5,
  usage: zeroUsage(),
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  lastPlayedAt: 1_700_000_000_000,
  ...overrides,
});

/** Mira Voss, a level-3 Wizard (Evoker) with the Sage background, a High Elf. */
export const sampleCharacter = (overrides: Partial<Character> = {}): Character => ({
  id: 'char-1',
  campaignId: 'camp-1',
  name: 'Mira Voss',
  pronouns: 'she/her',
  species: 'Elf (High Elf lineage)',
  speciesId: 'srd:species:elf',
  background: 'Sage',
  backgroundId: 'srd:background:sage',
  classes: [
    {
      classId: 'srd:class:wizard',
      name: 'Wizard',
      level: 3,
      hitDie: 6,
      subclass: 'Evoker',
      casterType: 'full',
      spellcastingAbility: 'int',
    },
  ],
  alignment: 'Neutral Good',
  xp: 900,
  abilityScores: { str: 8, dex: 14, con: 13, int: 17, wis: 12, cha: 10 },
  savingThrows: ['int', 'wis'],
  skills: { arcana: 1, history: 1, investigation: 1, perception: 1 },
  tools: ["Calligrapher's Supplies"],
  languages: ['Common', 'Elvish', 'Draconic', 'Sylvan'],
  weaponProficiencies: ['Simple weapons'],
  armorTraining: [],
  armorClass: 12,
  acFormula: '10 + DEX',
  speed: 30,
  size: 'Medium',
  darkvision: 60,
  hp: { max: 17, current: 12, temp: 0 },
  hitDice: [{ die: 6, total: 3, spent: 1 }],
  deathSaves: { successes: 0, failures: 0, stable: false, dead: false },
  conditions: [],
  exhaustion: 0,
  heroicInspiration: true,
  spellcasting: {
    ability: 'int',
    slots: { 1: { max: 4, used: 1 }, 2: { max: 2, used: 0 } },
    spells: [
      { id: 'srd:spell:fire-bolt', name: 'Fire Bolt', level: 0, prepared: true, source: 'Wizard' },
      { id: 'srd:spell:light', name: 'Light', level: 0, prepared: true, source: 'Wizard' },
      { id: 'srd:spell:mage-hand', name: 'Mage Hand', level: 0, prepared: true, source: 'Wizard' },
      { id: 'srd:spell:prestidigitation', name: 'Prestidigitation', level: 0, prepared: true, source: 'High Elf' },
      { id: 'srd:spell:magic-missile', name: 'Magic Missile', level: 1, prepared: true, source: 'Wizard' },
      { id: 'srd:spell:shield', name: 'Shield', level: 1, prepared: true, source: 'Wizard' },
      { id: 'srd:spell:detect-magic', name: 'Detect Magic', level: 1, prepared: true, source: 'Wizard', ritual: true, concentration: true },
      { id: 'srd:spell:sleep', name: 'Sleep', level: 1, prepared: false, source: 'Wizard', concentration: true },
      { id: 'srd:spell:misty-step', name: 'Misty Step', level: 2, prepared: true, source: 'Wizard' },
      { id: 'srd:spell:scorching-ray', name: 'Scorching Ray', level: 2, prepared: true, source: 'Wizard' },
    ],
    concentratingOn: null,
  },
  features: [
    {
      id: 'feat-arcane-recovery',
      name: 'Arcane Recovery',
      source: 'class',
      sourceName: 'Wizard 1',
      description: 'Once per day after a short rest, recover expended spell slots with a combined level up to half your wizard level (rounded up), none 6th level or higher.',
      uses: { max: 1, used: 0, recharge: 'long' },
    },
    {
      id: 'feat-magic-initiate',
      name: 'Magic Initiate (Wizard)',
      source: 'feat',
      sourceName: 'Sage (Origin feat)',
      description: 'Two wizard cantrips and one level 1 wizard spell you can cast once per long rest without a slot.',
      uses: { max: 1, used: 1, recharge: 'long' },
    },
    {
      id: 'feat-fey-ancestry',
      name: 'Fey Ancestry',
      source: 'species',
      sourceName: 'Elf',
      description: 'You have Advantage on saving throws you make to avoid or end the Charmed condition.',
    },
  ],
  attacks: [
    {
      id: 'atk-dagger',
      name: 'Dagger',
      ability: 'finesse',
      proficient: true,
      damage: '1d4',
      damageType: 'piercing',
      range: '20/60 ft.',
      properties: ['Finesse', 'Light', 'Thrown'],
      mastery: 'Nick',
    },
    {
      id: 'atk-fire-bolt',
      name: 'Fire Bolt',
      ability: 'spell',
      proficient: true,
      damage: '1d10',
      damageType: 'fire',
      addAbilityToDamage: false,
      range: '120 ft.',
    },
  ],
  inventory: [
    { id: 'item-dagger', name: 'Dagger', quantity: 2, weight: 1, category: 'weapon', equipped: true },
    { id: 'item-spellbook', name: 'Spellbook', quantity: 1, weight: 3, category: 'gear' },
    { id: 'item-arcane-focus', name: 'Quarterstaff (arcane focus)', quantity: 1, weight: 4, category: 'weapon' },
    { id: 'item-healing', name: 'Potion of Healing', quantity: 2, weight: 0.5, category: 'consumable', magic: true },
    { id: 'item-robe', name: 'Robe', quantity: 1, weight: 4, category: 'gear' },
  ],
  currency: { cp: 14, sp: 30, ep: 0, gp: 23, pp: 0 },
  personality: {
    traits: 'Answers questions with more questions.',
    ideals: 'Knowledge should be shared.',
    bonds: 'My missing mentor kept the lighthouse.',
    flaws: 'I can never leave a locked book unopened.',
    appearance: 'Ink-stained fingers, sea-glass earrings.',
    backstory: 'Apprenticed to the lighthouse keeper, who taught her that every light is a spell.',
  },
  notes: '',
  portrait: '🧝‍♀️',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

export const sampleSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-1',
  campaignId: 'camp-1',
  number: 1,
  status: 'active',
  model: 'claude-opus-5-5',
  systemPrompt: 'You are the DM…',
  startedAt: 1_700_000_000_000,
  endedAt: null,
  recap: null,
  dmNotes: null,
  usage: zeroUsage(),
  contextTokens: 18_400,
  ...overrides,
});

export const sampleCombat = (): CombatState => ({
  active: true,
  round: 2,
  turnIndex: 1,
  encounterName: 'Ambush on the docks',
  startedAt: 1_700_000_000_000,
  combatants: [
    { id: 'c-1', name: 'Mira Voss', side: 'player', isPlayer: true, initiative: 17, initiativeBonus: 2, ac: 12, conditions: [], defeated: false },
    {
      id: 'c-2',
      name: 'Bandit 1',
      side: 'enemy',
      isPlayer: false,
      initiative: 14,
      initiativeBonus: 1,
      ac: 12,
      hp: { max: 11, current: 4, temp: 0 },
      conditions: [],
      statBlockName: 'Bandit',
      defeated: false,
      hideHp: true,
    },
    {
      id: 'c-3',
      name: 'Bandit 2',
      side: 'enemy',
      isPlayer: false,
      initiative: 9,
      initiativeBonus: 1,
      ac: 12,
      hp: { max: 11, current: 11, temp: 0 },
      conditions: [{ id: 'prone' }],
      statBlockName: 'Bandit',
      defeated: false,
      hideHp: true,
    },
    {
      id: 'c-4',
      name: 'Old Tam',
      side: 'ally',
      isPlayer: false,
      initiative: 5,
      initiativeBonus: 0,
      ac: 11,
      hp: { max: 9, current: 9, temp: 0 },
      conditions: [],
      defeated: false,
    },
  ],
});

// ---------------------------------------------------------------------------
// Battle map (spec §9.6; worked examples in §5.4). Literal data: no engine calls.
// ---------------------------------------------------------------------------

// Squares are { x: column, y: row }, 0-based: A1 = { x: 0, y: 0 }, B6 = { x: 1, y: 5 }; rects are inclusive.

/**
 * "Dockside warehouse", 16×12 (the §4.5 setup): an office walled off in the north-east with a closed door, a
 * pillar, crates (half cover), spilled grain (difficult), a flooded dock (deep water) and a brazier (hazard).
 * Ids t1–t7, p8–p9 from one counter, so nextId is 10.
 */
export const sampleBattleMap = (): BattleMap => ({
  id: 'map-1',
  name: 'Dockside warehouse',
  width: 16,
  height: 12,
  terrain: [
    { id: 't1', kind: 'wall', rects: [{ x0: 11, y0: 4, x1: 15, y1: 4 }], label: 'office wall' }, // L5:P5
    { id: 't2', kind: 'door', rects: [{ x0: 13, y0: 4, x1: 13, y1: 4 }], label: 'office door', door: 'closed' }, // N5
    { id: 't3', kind: 'wall', rects: [{ x0: 8, y0: 3, x1: 8, y1: 3 }], label: 'pillar' }, // I4
    { id: 't4', kind: 'half-cover', rects: [{ x0: 4, y0: 4, x1: 5, y1: 5 }], label: 'crates' }, // E5:F6
    { id: 't5', kind: 'difficult', rects: [{ x0: 7, y0: 7, x1: 9, y1: 8 }], label: 'spilled grain' }, // H8:J9
    { id: 't6', kind: 'deep-water', rects: [{ x0: 13, y0: 9, x1: 15, y1: 11 }], label: 'flooded dock' }, // N10:P12
    { id: 't7', kind: 'hazard', rects: [{ x0: 6, y0: 10, x1: 6, y1: 10 }], label: 'brazier' }, // G11
  ],
  places: [
    // A5:B7 (not A5:A7) so that B5 and B6 are "(the loading door)" as in the §5.4 examples.
    { id: 'p8', name: 'the loading door', rects: [{ x0: 0, y0: 4, x1: 1, y1: 6 }] }, // A5:B7
    { id: 'p9', name: 'the office', rects: [{ x0: 11, y0: 0, x1: 15, y1: 3 }] }, // L1:P4
  ],
  effects: [],
  nextId: 10,
  rev: 0,
});

/**
 * sampleCombat() on the warehouse map, round 2: Mira Voss B6, Bandit 1 F4, the Cutthroat M8 (hidden from the
 * player), Bandit 2 F3 (Prone), Old Tam B5, the Dock Ogre H10:I11 (Large, walk 40). Initiative order: Mira 17,
 * Bandit 1 14, Cutthroat 12, Bandit 2 9, Old Tam 5, Dock Ogre 3. Bandit 1's turn, or the hero's with
 * `heroTurn` (§5.4 Example 1). No turn record yet: everyone has a fresh turn.
 */
export const sampleMappedCombat = (opts: { heroTurn?: boolean } = {}): CombatState => {
  const [mira, bandit1, bandit2, oldTam] = sampleCombat().combatants;
  return {
    ...sampleCombat(),
    encounterName: 'Ambush in the warehouse',
    turnIndex: opts.heroTurn ? 0 : 1,
    combatants: [
      { ...mira, position: { x: 1, y: 5 } }, // B6
      { ...bandit1, position: { x: 5, y: 3 } }, // F4
      {
        id: 'c-5',
        name: 'Cutthroat',
        side: 'enemy',
        isPlayer: false,
        initiative: 12,
        initiativeBonus: 3,
        ac: 14,
        hp: { max: 16, current: 16, temp: 0 },
        conditions: [],
        defeated: false,
        hideHp: true,
        position: { x: 12, y: 7 }, // M8
        hidden: true,
      },
      { ...bandit2, position: { x: 5, y: 2 } }, // F3
      { ...oldTam, position: { x: 1, y: 4 } }, // B5
      {
        id: 'c-6',
        name: 'Dock Ogre',
        side: 'enemy',
        isPlayer: false,
        initiative: 3,
        initiativeBonus: -1,
        ac: 11,
        hp: { max: 59, current: 59, temp: 0 },
        conditions: [],
        statBlockName: 'Ogre',
        defeated: false,
        hideHp: true,
        position: { x: 7, y: 9 }, // H10
        size: 'Large',
        speeds: { walk: 40 },
      },
    ],
    map: sampleBattleMap(),
  };
};

/**
 * §5.4 Example 2, round 3, the hero's turn: Bandit 1 closed to C5 and spent its Reaction on Old Tam, the Dock Ogre
 * closed to C7:D8, and the player's move B6 → A7 stopped at once on B6 (leaving the Ogre's reach provokes its
 * Opportunity Attack). The stop and its 0-ft move are unseen by the DM (no toldSeq).
 */
export const sampleStopCombat = (): CombatState => {
  const base = sampleMappedCombat({ heroTurn: true });
  const [mira, bandit1, cutthroat, bandit2, oldTam, ogre] = base.combatants;
  return {
    ...base,
    round: 3,
    combatants: [
      mira,
      { ...bandit1, position: { x: 2, y: 4 }, reactionUsed: true }, // C5
      cutthroat,
      bandit2,
      oldTam,
      { ...ogre, position: { x: 2, y: 6 } }, // C7 (C7:D8)
    ],
    map: {
      ...sampleBattleMap(),
      turn: {
        combatantId: 'c-1',
        round: 3,
        movedFt: 0,
        dashFt: 0,
        dashes: 0,
        disengaged: false,
        stoodUp: false,
        moves: [
          {
            by: 'player',
            kind: 'move',
            from: { x: 1, y: 5 }, // B6
            to: { x: 1, y: 5 }, // B6
            path: [],
            costFt: 0,
            provoked: [{ reactorId: 'c-6', at: { x: 1, y: 5 }, hidden: false }], // B6
            entered: [],
          },
        ],
      },
      stop: {
        moverId: 'c-1',
        by: 'player',
        round: 3,
        at: { x: 1, y: 5 }, // B6
        destination: { x: 0, y: 6 }, // A7
        route: [{ x: 0, y: 6 }], // A7
        reactorIds: ['c-6'],
        declinedIds: [],
        opts: { prefer: 'safest' },
      },
    },
  };
};

export const sampleJournal = (): JournalEntry[] => [
  {
    id: 'j-1',
    campaignId: 'camp-1',
    kind: 'npc',
    name: 'Old Tam',
    summary: 'A one-eyed net mender who saw the lantern light itself.',
    status: 'ally',
    tags: ['dockhand', 'witness'],
    secret: false,
    firstSession: 1,
    lastSession: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'j-2',
    campaignId: 'camp-1',
    kind: 'location',
    name: 'The Drowned Lantern',
    summary: 'The abandoned lighthouse on the breakwater, lit for the first time in forty years.',
    tags: ['lighthouse'],
    secret: false,
    firstSession: 1,
    lastSession: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'j-3',
    campaignId: 'camp-1',
    kind: 'npc',
    name: 'Keeper Halvard',
    summary: 'The missing keeper. Secretly bound to something under the water.',
    status: 'missing',
    tags: ['mentor'],
    secret: true,
    firstSession: 1,
    lastSession: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'j-4',
    campaignId: 'camp-1',
    kind: 'ruling',
    name: 'Climbing wet stone',
    summary: 'Climbing the slick breakwater stones counts as Difficult Terrain; Athletics DC 12 to move at full speed.',
    tags: [],
    secret: false,
    firstSession: 1,
    lastSession: 1,
    createdAt: 1,
    updatedAt: 1,
  },
];

export const sampleQuests = (): Quest[] => [
  {
    id: 'q-1',
    campaignId: 'camp-1',
    title: 'Find Keeper Halvard',
    status: 'active',
    summary: 'Your mentor vanished the night the lantern relit.',
    giver: 'Yourself',
    objectives: [
      { id: 'o-1', text: 'Question Old Tam', done: true },
      { id: 'o-2', text: 'Reach the lighthouse at low tide', done: false },
    ],
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'q-2',
    campaignId: 'camp-1',
    title: 'The smugglers of Gull Cove',
    status: 'rumor',
    summary: 'Tam mentioned boats without lights.',
    objectives: [],
    createdAt: 1,
    updatedAt: 1,
  },
];

export const sampleClocks = (): Clock[] => [
  {
    id: 'clk-1',
    campaignId: 'camp-1',
    name: 'The tide turns',
    consequence: 'The causeway floods and the lighthouse is cut off until dawn.',
    segments: 4,
    filled: 1,
    kind: 'countdown',
    secret: false,
    resolved: false,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'clk-2',
    campaignId: 'camp-1',
    name: 'Something stirs below',
    consequence: 'The drowned thing rises into the harbor.',
    segments: 6,
    filled: 2,
    kind: 'threat',
    secret: true,
    resolved: false,
    createdAt: 1,
    updatedAt: 1,
  },
];

let seq = 0;
const base = (kind: string) => ({ id: `log-${++seq}-${kind}`, campaignId: 'camp-1', sessionId: 'sess-1', seq, createdAt: 1_700_000_000_000 + seq * 1000 });

/** One log entry of every kind, in a plausible order. */
export const sampleLog = (): LogEntry[] => {
  seq = 0;
  return [
    { ...base('session'), kind: 'session', event: 'start', sessionNumber: 1 },
    {
      ...base('dm'),
      kind: 'dm',
      text: 'Fog rolls off the water as you reach the **Saltmarsh docks**. Out on the breakwater, the drowned lantern burns a cold green.\n\nOld Tam looks up from his nets. *"You came,"* he says. *"Then you saw it too."*',
    },
    { ...base('player'), kind: 'player', text: 'I sit beside Tam and ask what exactly he saw that night.' },
    {
      ...base('roll'),
      kind: 'roll',
      actor: 'player',
      purpose: 'Insight check',
      secret: false,
      roll: {
        expression: '1d20+1',
        total: 15,
        dice: [{ sides: 20, value: 14 }],
        modifier: 1,
        breakdown: 'd20 (14) + 1 = 15',
        natural: 14,
        dc: 12,
        success: true,
      },
    },
    {
      ...base('roll'),
      kind: 'roll',
      actor: 'dm',
      purpose: 'Bandit stealth (secret)',
      secret: true,
      roll: {
        expression: '1d20+2',
        total: 9,
        dice: [{ sides: 20, value: 7 }],
        modifier: 2,
        breakdown: 'd20 (7) + 2 = 9',
        natural: 7,
      },
    },
    { ...base('tool'), kind: 'tool', tool: 'update_journal', icon: 'journal', summary: 'Journal: Old Tam (NPC) added' },
    {
      ...base('dm'),
      kind: 'dm',
      text: 'Tam is telling the truth — and he is frightened. Behind you, boots scrape on wet planks.',
      choices: ['Turn and face them', 'Pull Tam behind the nets', 'Cast Light to see who it is'],
    },
    { ...base('tool'), kind: 'tool', tool: 'start_combat', icon: 'combat', summary: 'Combat started: Ambush on the docks (4 combatants)' },
    {
      ...base('roll'),
      kind: 'roll',
      actor: 'dm',
      purpose: 'Bandit 1 attacks Mira',
      secret: false,
      roll: {
        expression: '1d20+3',
        total: 23,
        dice: [{ sides: 20, value: 20 }],
        modifier: 3,
        breakdown: 'd20 (20) + 3 = 23',
        natural: 20,
        isCritical: true,
        dc: 12,
        success: true,
      },
    },
    { ...base('tool'), kind: 'tool', tool: 'update_character', icon: 'hp', summary: 'HP 17 → 12 (5 slashing)' },
    { ...base('system'), kind: 'system', level: 'info', text: 'You edited your character sheet. The DM will be told on your next turn.' },
    { ...base('error'), kind: 'error', text: 'The DM could not be reached (network error).', retryable: true },
  ];
};
