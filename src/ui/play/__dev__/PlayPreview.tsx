/**
 * DEV-ONLY visual preview of the Play screen with fixture data and fake store actions (no
 * IndexedDB, no DM). Lazily imported by ./main.tsx (or the app) only when import.meta.env.DEV and
 * the URL has ?preview=play.
 *
 * Query options: roll=prompt|physical|damage (open a roll prompt), dm=streaming|thinking|error,
 * tab=story|sheet|combat|journal|rules (mobile), combat=0 (no combat), empty=1 (no log yet),
 * ended=1 (between sessions), mock=1 (Demo badge), transformed=1 (the hero has a transformation).
 */
import { useEffect } from 'react';
import { MemoryRouter, useInRouterContext } from 'react-router';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { Character, Clock, InteractionRequest, LogEntry, PlayerRollMode, Quest } from '@/types';
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
