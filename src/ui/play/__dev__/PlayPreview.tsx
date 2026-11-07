/**
 * DEV-ONLY visual preview of the Play screen with fixture data and fake store actions (no
 * IndexedDB, no DM). Lazily imported by ./main.tsx (or the app) only when import.meta.env.DEV and
 * the URL has ?preview=play.
 *
 * Query options: roll=prompt|physical|damage (open a roll prompt), dm=streaming|thinking|error,
 * tab=story|sheet|combat|journal|rules (mobile), combat=0 (no combat), empty=1 (no log yet),
 * ended=1 (between sessions), mock=1 (Demo badge).
 */
import { useEffect } from 'react';
import { MemoryRouter, useInRouterContext } from 'react-router';
import { useGame, type GameStoreState } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { InteractionRequest, LogEntry, PlayerRollMode } from '@/types';
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
      request: { rollType: 'damage', attackName: 'Dagger', expression: '1d4+2', critical: true, revealDc: false, advantage: 'normal', reason: 'Your dagger finds the gap in his guard' },
      modifier: 0,
      label: 'Dagger damage',
    };
  }
  if (kind === 'prompt' || kind === 'physical') {
    return {
      kind: 'roll',
      id: 'preview-roll',
      request: { rollType: 'skill', skill: 'stealth', dc: 13, revealDc: true, advantage: 'advantage', reason: 'Slip past the bandits on the wet planks' },
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

/** Entries sampleLog() lacks: a recap, DM notes, a player OOC line and a homebrew line. */
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
  const narration = second?.kind === 'dm' ? { ...second, reasoning: 'Tam knows more than he says. If Mira presses him, reveal the smugglers.' } : second;
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
  ];
  return [first, recap, narration, ...rest, ...extra].filter((e): e is LogEntry => Boolean(e));
}

function seed(params: URLSearchParams): void {
  const state: Partial<GameStoreState> = fixtureState();
  if (params.get('extra') !== '0') state.log = withExtraEntries(state.log ?? []);
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
    state.dm = { phase: 'error', activity: null, error: 'The DM could not be reached (network error).', retryable: true };
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
