/**
 * TEST ONLY: an in-memory stand-in for '@/state/gameStore' with spy actions, so UI tests don't
 * depend on storage. Usage:
 *
 *   vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());
 *   beforeEach(() => resetFakeGame({ character: sampleCharacter(), campaign: sampleCampaign() }));
 */
import { vi } from 'vitest';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { GameStore } from '@/state/gameStore';
import type { Campaign, Character, LogEntry } from '@/types';

export type FakeGame = UseBoundStore<StoreApi<GameStore>>;

const initialDmStatus = { phase: 'idle' as const, activity: null, error: null, retryable: false };

const notUsed = (name: string) => () => {
  throw new Error(`fakeGameStore: ${name} is not faked`);
};

function actions(get: () => GameStore, set: (partial: Partial<GameStore>) => void): Partial<GameStore> {
  return {
    loadCampaign: vi.fn(async () => undefined),
    updateCampaign: vi.fn(async (patch: Partial<Campaign> | ((c: Campaign) => Campaign)) => {
      const current = get().campaign!;
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      set({ campaign: next });
      return next;
    }),
    setCharacter: vi.fn(async (character: Character) => {
      set({ character, campaign: get().campaign ? { ...get().campaign!, characterId: character.id } : null });
    }),
    updateCharacter: vi.fn(async (fn: (c: Character) => Character) => {
      const current = get().character;
      if (!current) throw new Error('No character loaded');
      const next = { ...fn(current), updatedAt: current.updatedAt + 1 };
      set({ character: next });
      return next;
    }),
    queueDmNotice: vi.fn((text: string) => set({ pendingDmNotices: [...get().pendingDmNotices, text] })),
    appendLog: vi.fn(async (entry) => {
      const log = get().log;
      const full = { ...entry, id: `log-${log.length + 1}`, campaignId: 'camp-1', sessionId: null, seq: log.length + 1, createdAt: 1 } as LogEntry;
      set({ log: [...log, full] });
      return full;
    }),
  };
}

function baseState(): GameStore {
  const missing = [
    'unloadCampaign',
    'reload',
    'startSession',
    'updateSession',
    'endActiveSession',
    'appendTranscript',
    'truncateTranscriptAfter',
    'updateLog',
    'removeLog',
    'setCombat',
    'upsertJournal',
    'deleteJournal',
    'upsertQuest',
    'deleteQuest',
    'upsertClock',
    'deleteClock',
    'saveHomebrew',
    'deleteHomebrew',
    'addUsage',
    'setDmStatus',
    'requestInteraction',
    'resolveInteraction',
    'cancelInteraction',
    'takeDmNotices',
  ] as const;
  const stubs = Object.fromEntries(missing.map((name) => [name, notUsed(name)])) as unknown as GameStore;
  return {
    ...stubs,
    campaignId: null,
    campaign: null,
    character: null,
    sessions: [],
    activeSession: null,
    transcript: [],
    log: [],
    combat: null,
    journal: [],
    quests: [],
    clocks: [],
    homebrew: [],
    dm: initialDmStatus,
    interaction: null,
    pendingDmNotices: [],
    loading: false,
    loadError: null,
  } as GameStore;
}

let store: FakeGame | null = null;

export function fakeGameStoreModule(): { useGame: FakeGame; initialDmStatus: typeof initialDmStatus } {
  store = create<GameStore>()(() => baseState());
  return { useGame: store, initialDmStatus };
}

/** Reset the fake store with fresh spies and the given state. */
export function resetFakeGame(state: Partial<GameStore> = {}): FakeGame {
  if (!store) throw new Error('Mock @/state/gameStore with fakeGameStoreModule() first.');
  const s = store;
  s.setState(
    {
      ...baseState(),
      ...actions(s.getState, (p) => s.setState(p)),
      campaignId: state.campaign?.id ?? null,
      ...state,
    },
    true,
  );
  return s;
}

/** Make jsdom's <dialog> support showModal()/close() (used by the shared Dialog component). */
export function installDialogPolyfill(): void {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal?: () => void; close?: () => void };
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
}
