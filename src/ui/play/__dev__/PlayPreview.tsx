/**
 * DEV-ONLY visual preview of the Play screen with fixture data and fake store actions (no
 * IndexedDB, no DM). Lazily imported by ./main.tsx (or the app) only when import.meta.env.DEV and
 * the URL has ?preview=play.
 *
 * Query options: roll=prompt|physical|damage (open a roll prompt), dm=streaming|thinking|error,
 * tab=story|sheet|combat|journal|rules (mobile), combat=0 (no combat), empty=1 (no log yet),
 * ended=1 (between sessions), mock=1 (Demo badge), transformed=1 (the hero has a transformation),
 * confirm=oa (the hero's Opportunity Attack question), map=1 (the warehouse battle map, the hero's turn) | map=npc (Bandit 1's turn) | map=hidden (the hidden Cutthroat's
 * turn) | map=stop (a pending Opportunity Attack stop) | map=big (40×40, 30 creatures: the performance case),
 * spoilers=1 ("Show DM secrets").
 */
import { useEffect } from 'react';
import { MemoryRouter, useInRouterContext } from 'react-router';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { Character, Clock, Combatant, CombatState, InteractionRequest, LogEntry, PlayerRollMode, Quest } from '@/types';
import { Toaster } from '@/ui/components/toast';
import { PlayTable } from '../PlayTable';
import { usePlayView, type MobileTab } from '../playView';
import { createFakeActions, fixtureState } from '../testing/fakeGame';

const MOBILE_TABS: MobileTab[] = ['story', 'sheet', 'combat', 'journal', 'rules'];

function rollInteraction(kind: string | null): InteractionRequest | null {
  if (kind === 'damage') {
    return {
      kind: 'roll',
      id: 'preview-roll',
      request: {
        rollType: 'damage',
        attackName: 'Dagger',
        expression: '1d4+2',
        critical: true,
        revealDc: false,
        advantage: 'normal',
        reason: 'Your dagger finds the gap in his guard',
      },
      modifier: 0,
      label: 'Dagger damage',
    };
  }
  if (kind === 'prompt' || kind === 'physical') {
    return {
      kind: 'roll',
      id: 'preview-roll',
      request: {
        rollType: 'skill',
        skill: 'stealth',
        dc: 13,
        revealDc: true,
        advantage: 'advantage',
        reason: 'Slip past the bandits on the wet planks',
      },
      modifier: 2,
      label: 'Stealth check (DEX)',
    };
  }
  return null;
}

function streamingEntry(): LogEntry {
  return {
    id: 'preview-streaming',
    campaignId: 'camp-1',
    sessionId: 'sess-1',
    seq: 999,
    createdAt: Date.now(),
    kind: 'dm',
    streaming: true,
    text: 'The second bandit scrambles up from the planks, knife low, and circles toward Tam. Fog swallows the lantern light—',
  };
}

/** An ambition (a goal the player set) and the progress clock that shares its name. */
function ambition(): { quest: Quest; clock: Clock } {
  const base = { campaignId: 'camp-1', createdAt: 2, updatedAt: 2 };
  return {
    quest: {
      ...base,
      id: 'preview-ambition',
      title: "Found a thieves' guild",
      status: 'active',
      summary: 'Bring the cutpurses of Saltmarsh under one roof — yours.',
      objectives: [{ id: 'preview-step', text: 'Win over Nell the fence', done: false }],
      ambition: true,
    },
    clock: {
      ...base,
      id: 'preview-ambition-clock',
      name: "Found a thieves' guild",
      segments: 8,
      filled: 3,
      kind: 'progress',
      consequence: 'The guild is yours.',
      secret: false,
      resolved: false,
    },
  };
}

/** The hero partway through a transformation, with the features it gave. */
function transformed(character: Character): Character {
  return {
    ...character,
    features: [
      ...character.features,
      {
        id: 'preview-moonlit-sight',
        name: 'Moonlit Sight',
        source: 'transformation',
        sourceName: 'Moonblood',
        description: 'You have Darkvision out to 60 feet; in moonlight you can see colors.',
      },
      {
        id: 'preview-sun-dazzled',
        name: 'Sun-Dazzled',
        source: 'transformation',
        sourceName: 'Moonblood',
        description: 'In direct sunlight you have Disadvantage on sight-based Perception checks.',
        uses: { max: 1, used: 0, recharge: 'long' },
      },
    ],
    transformations: [
      {
        id: 'preview-moonblood',
        name: 'Moonblood',
        summary: 'The Moonwell’s light runs in your veins: you see in the dark, but sunlight dazzles you.',
        stage: 'Stage 1 of 2',
        origin: 'accepted',
        status: 'active',
        howItEnds: 'Drink from a sunwell at noon, or let the next full moon claim you.',
        featureIds: ['preview-moonlit-sight', 'preview-sun-dazzled'],
        startedSession: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'preview-tide-blessing',
        name: 'Blessing of the Tide',
        summary: 'The sea goddess marked you for a season.',
        origin: 'accepted',
        status: 'ended',
        featureIds: [],
        startedSession: 1,
        endedSession: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

/** Entries sampleLog() lacks: a recap, DM notes, a player OOC line, homebrew, a transformation, a picture. */
function withExtraEntries(log: LogEntry[]): LogEntry[] {
  const base = { campaignId: 'camp-1', sessionId: 'sess-1', createdAt: Date.now() };
  const [first, second, ...rest] = log;
  const recap: LogEntry = {
    ...base,
    id: 'preview-recap',
    seq: 1.5,
    kind: 'recap',
    sessionNumber: 1,
    text: 'You came home to **Saltmarsh** the night the drowned lantern relit itself. Old Tam swore he saw a figure on the gallery, and your mentor, Keeper Halvard, is nowhere to be found.',
  };
  const narration =
    second?.kind === 'dm'
      ? { ...second, reasoning: 'Tam knows more than he says. If Mira presses him, reveal the smugglers.' }
      : second;
  const extra: LogEntry[] = [
    { ...base, id: 'preview-ooc', seq: 900, kind: 'player', text: 'OOC: Does Shield work against this crit?' },
    {
      ...base,
      id: 'preview-homebrew',
      seq: 901,
      kind: 'tool',
      tool: 'create_homebrew',
      icon: 'homebrew',
      summary: "Homebrew created: Tidecaller's Mark (boon)",
      detail: 'Once per long rest, breathe underwater for 10 minutes.',
    },
    {
      ...base,
      id: 'preview-transformation',
      seq: 902,
      kind: 'tool',
      tool: 'transform_character',
      icon: 'transform',
      summary: 'Transformation: Moonblood begins — Stage 1 of 2',
      detail: '- Gained feature: Moonlit Sight\n- Gained feature: Sun-Dazzled\n\n**How it could end:** drink from a sunwell at noon.',
    },
    {
      ...base,
      id: 'preview-image-failed',
      seq: 903,
      kind: 'image',
      imageId: 'preview-image',
      title: 'The drowned lantern at dusk',
      subject: 'scene',
      status: 'failed',
      error: 'The image service declined this picture.',
    },
  ];
  return [first, recap, narration, ...rest, ...extra].filter((e): e is LogEntry => Boolean(e));
}

/**
 * The performance case of spec §7.12: a 40×40 map with every terrain kind and 30 creatures (the hero's turn), so
 * pan, zoom, plans and the first paint can be timed on the largest map the app allows.
 */
function bigMappedCombat(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  const hero = { ...base.combatants[0], position: { x: 19, y: 30 } };
  const others: Combatant[] = Array.from({ length: 29 }, (_, i) => {
    const enemy = i % 5 !== 0;
    const at = { x: 3 + ((i * 7) % 34), y: 2 + Math.floor(i / 6) * 4 + (i % 2) };
    return {
      id: `big-${i + 1}`,
      name: enemy ? `Bandit ${i + 1}` : `Guard ${i + 1}`,
      side: enemy ? 'enemy' : 'ally',
      isPlayer: false,
      initiative: 16 - (i % 15),
      initiativeBonus: 1,
      ac: 12,
      hp: { max: 11, current: 11 - (i % 7), temp: 0 },
      conditions: i % 4 === 0 ? [{ id: 'prone' }] : [],
      defeated: i === 13,
      hideHp: enemy,
      position: at,
      ...(i % 9 === 4 ? { size: 'Large' as const } : {}),
    };
  });
  const rect = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });
  return {
    ...base,
    encounterName: 'Siege of the old keep',
    combatants: [hero, ...others],
    map: {
      id: 'map-1',
      name: 'The old keep',
      width: 40,
      height: 40,
      terrain: [
        { id: 't1', kind: 'wall', rects: [rect(0, 0, 39, 0), rect(0, 39, 39, 39), rect(0, 0, 0, 39), rect(39, 0, 39, 39), rect(12, 10, 12, 26), rect(26, 14, 34, 14)], label: 'keep walls' },
        { id: 't2', kind: 'door', rects: [rect(12, 18, 12, 18)], label: 'gate', door: 'closed' },
        { id: 't3', kind: 'difficult', rects: [rect(15, 20, 22, 24), rect(30, 30, 36, 33)], label: 'rubble' },
        { id: 't4', kind: 'deep-water', rects: [rect(2, 30, 9, 37)], label: 'moat' },
        { id: 't5', kind: 'shallow-water', rects: [rect(10, 33, 13, 37)], label: 'ford' },
        { id: 't6', kind: 'half-cover', rects: [rect(18, 27, 21, 27), rect(5, 5, 7, 6)], label: 'barricade' },
        { id: 't7', kind: 'three-quarters-cover', rects: [rect(26, 20, 26, 22)], label: 'arrow slits' },
        { id: 't8', kind: 'pit', rects: [rect(30, 5, 32, 7)], label: 'well' },
        { id: 't9', kind: 'hazard', rects: [rect(24, 28, 24, 28), rect(8, 15, 8, 15)], label: 'braziers' },
        { id: 't10', kind: 'obscured', rects: [rect(33, 22, 37, 26)], label: 'smoke' },
      ],
      places: [{ id: 'p11', name: 'the courtyard', rects: [rect(14, 16, 30, 28)] }],
      effects: [],
      nextId: 12,
      rev: 0,
    },
  };
}

/** The battle-map fixtures (§9.6) for map=1|npc|hidden|stop|big, with the log line that put the fight on the map. */
function mappedCombat(kind: string): CombatState {
  if (kind === 'stop') return sampleStopCombat();
  if (kind === 'npc') return sampleMappedCombat();
  if (kind === 'hidden') return { ...sampleMappedCombat(), turnIndex: 2 };
  if (kind === 'big') return bigMappedCombat();
  return sampleMappedCombat({ heroTurn: true });
}

function mapLogLine(): LogEntry {
  return {
    id: 'preview-map',
    campaignId: 'camp-1',
    sessionId: 'sess-1',
    seq: 950,
    createdAt: Date.now(),
    kind: 'tool',
    tool: 'update_map',
    icon: 'map',
    summary: 'Battle map: Dockside warehouse (16×12)',
    detail: 'The loading door is to the west; the office in the north-east is walled off.',
  };
}

function seed(params: URLSearchParams): void {
  const state: Partial<GameStoreState> = fixtureState();
  if (params.get('extra') !== '0') {
    state.log = withExtraEntries(state.log ?? []);
    const { quest, clock } = ambition();
    state.quests = [...(state.quests ?? []), quest];
    state.clocks = [...(state.clocks ?? []), clock];
  }
  if (params.get('transformed') === '1' && state.character) state.character = transformed(state.character);
  const rollKind = params.get('roll');
  const interaction = rollInteraction(rollKind);
  if (state.campaign && interaction) {
    const mode: PlayerRollMode = rollKind === 'physical' ? 'physical' : 'prompt';
    state.campaign = { ...state.campaign, settings: { ...state.campaign.settings, playerRollMode: mode } };
    state.interaction = interaction;
    state.dm = { phase: 'waiting-player', activity: 'Waiting for your roll…', error: null, retryable: false };
  }
  // confirm=oa: the hero's Opportunity Attack question as move_tokens asks it (D32).
  if (params.get('confirm') === 'oa') {
    state.interaction = {
      kind: 'confirm',
      id: 'preview-oa',
      title: 'Opportunity Attack',
      body: 'Bandit 1 is leaving your reach (from C5). Use your Reaction to make one melee attack against it?',
      confirmLabel: 'Attack',
      cancelLabel: 'Let it go',
    };
    state.dm = { phase: 'waiting-player', activity: 'Waiting for your answer: Opportunity Attack…', error: null, retryable: false };
  }
  const dm = params.get('dm');
  if (dm === 'streaming') {
    state.log = [...(state.log ?? []), streamingEntry()];
    state.dm = { phase: 'streaming', activity: null, error: null, retryable: false };
  } else if (dm === 'thinking') {
    state.dm = { phase: 'thinking', activity: null, error: null, retryable: false };
  } else if (dm === 'error') {
    state.dm = {
      phase: 'error',
      activity: null,
      error: 'The DM could not be reached (network error).',
      retryable: true,
    };
  }
  if (params.get('combat') === '0') state.combat = null;
  const map = params.get('map');
  if (map && map !== '0') {
    state.combat = mappedCombat(map);
    state.log = [...(state.log ?? []), mapLogLine()];
  }
  if (params.get('empty') === '1') state.log = [];
  if (params.get('ended') === '1') {
    state.activeSession = null;
    if (state.campaign) state.campaign = { ...state.campaign, activeSessionId: null };
  }
  useGame.setState({ ...state, ...createFakeActions() });
  useSettings.setState({ mockMode: params.get('mock') === '1' });
}

/** View state is reset when the table (re)mounts, so apply it after the table's own effects. */
function applyViewParams(params: URLSearchParams): void {
  const tab = params.get('tab') as MobileTab | null;
  usePlayView.setState({
    mobileTab: tab && MOBILE_TABS.includes(tab) ? tab : 'story',
    showSpoilers: params.get('spoilers') === '1',
    revealAllDmRolls: params.get('reveal') === '1',
  });
}

// Seed before the first render so no component sees an empty store.
seed(new URLSearchParams(window.location.search));

export default function PlayPreview() {
  const inRouter = useInRouterContext();
  useEffect(() => applyViewParams(new URLSearchParams(window.location.search)), []);
  const table = (
    <>
      <PlayTable />
      <Toaster />
    </>
  );
  return inRouter ? table : <MemoryRouter>{table}</MemoryRouter>;
}
