/**
 * Test harness: an in-memory store seeded from the shared fixtures, a fake client, and DM deps
 * that never touch IndexedDB, the network or real timers.
 *
 * Test files must mock the other modules first:
 *   vi.mock('@/engine', () => import('./testing/fakeEngine'));
 *   vi.mock('@/data', () => import('./testing/fakeData'));
 */
import { vi } from 'vitest';
import type { GameStore, GameStoreState } from '@/state/gameStore';
import {
  sampleCampaign,
  sampleCharacter,
  sampleClocks,
  sampleJournal,
  sampleQuests,
  sampleSession,
  zeroUsage,
} from '@/test/fixtures';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Campaign,
  type CampaignSettings,
  type Character,
  type D20TestResult,
  type InteractionRequest,
  type InteractionResponse,
} from '@/types';
import { setDmDeps, type DmImages } from '../deps';
import { DmSessionController } from '../session';
import { createFakeRulesIndex, SAMPLE_RULES } from './fakeData';
import { autoRespond, createFakeGameStore, type FakeGameStore } from './fakeStore';
import { FakeClient, type ScriptStep } from './fakeClient';

export interface HarnessOptions {
  settings?: Partial<AppSettings>;
  campaign?: Partial<Campaign>;
  campaignSettings?: Partial<CampaignSettings>;
  character?: Character | null;
  /** Start with an active session (empty transcript) instead of none. */
  withSession?: boolean;
  steps?: ScriptStep[];
  state?: Partial<GameStoreState>;
  /** Imported books switched on in the Library (default: none). */
  libraryImports?: { id: string; name: string }[];
  /** Illustrations (default: no OpenAI key, so unavailable). */
  images?: Partial<DmImages>;
}

/** What the images module says when no OpenAI key is set (the harness default). */
export const NO_IMAGE_KEY = 'add an OpenAI API key in Settings → Illustrations to have pictures painted';

export interface Harness {
  store: FakeGameStore;
  /** Fresh state snapshot. */
  s: () => GameStore;
  client: FakeClient;
  settings: AppSettings;
  controller: DmSessionController;
  invalidateRulesIndex: ReturnType<typeof vi.fn>;
}

export function setupHarness(opts: HarnessOptions = {}): Harness {
  const base = sampleCampaign({ activeSessionId: null, sessionCount: 0, ...opts.campaign });
  const campaign: Campaign = { ...base, settings: { ...base.settings, ...opts.campaignSettings }, usage: zeroUsage() };
  const session = sampleSession({ systemPrompt: 'FROZEN SYSTEM PROMPT', contextTokens: 0 });
  const withSession = opts.withSession ?? false;
  const store = createFakeGameStore({
    campaignId: campaign.id,
    campaign: withSession ? { ...campaign, activeSessionId: session.id, sessionCount: 1 } : campaign,
    character: opts.character === undefined ? sampleCharacter() : opts.character,
    sessions: withSession ? [session] : [],
    activeSession: withSession ? session : null,
    journal: sampleJournal(),
    quests: sampleQuests(),
    clocks: sampleClocks(),
    ...opts.state,
  });
  const client = new FakeClient(opts.steps);
  const settings: AppSettings = { ...DEFAULT_SETTINGS, apiKey: 'sk-ant-test', ...opts.settings };
  const invalidate = vi.fn();
  let ids = 0;
  const index = createFakeRulesIndex(SAMPLE_RULES);
  setDmDeps({
    store: () => store.getState(),
    settings: () => settings,
    client: () => client,
    keyClient: () => ({ models: { list: async () => ({ data: [] }) } }),
    rulesIndex: async () => index,
    invalidateRulesIndex: invalidate,
    libraryImports: async () => opts.libraryImports ?? [],
    images: {
      available: () => ({ ok: false, reason: NO_IMAGE_KEY }),
      request: async () => ({ ok: false, reason: NO_IMAGE_KEY }),
      ...opts.images,
    },
    rng: undefined,
    now: () => 1_700_000_000_000,
    newId: () => `id-${++ids}`,
    sleep: async () => undefined,
    streamThrottleMs: 0,
  });
  return { store, s: () => store.getState(), client, settings, controller: new DmSessionController(), invalidateRulesIndex: invalidate };
}

/** A roll result as the roll dialog would return it. */
export function dialogRoll(natural: number, modifier: number, dc?: number): D20TestResult {
  const total = natural + modifier;
  return {
    expression: `1d20+${modifier}`,
    total,
    dice: [{ sides: 20, value: natural }],
    modifier,
    breakdown: `d20 (${natural}) + ${modifier} = ${total}`,
    natural,
    isCritical: natural === 20,
    isFumble: natural === 1,
    ...(dc !== undefined ? { dc, success: total >= dc } : {}),
  };
}

/** Answer every roll dialog with the given natural d20 (and the requested modifier). */
export function answerRolls(store: FakeGameStore, natural: number, manual = false): () => void {
  return autoRespond(store, (request: InteractionRequest): InteractionResponse | null => {
    if (request.kind !== 'roll') return null;
    return { kind: 'roll', response: { result: dialogRoll(natural, request.modifier, request.request.dc), manual } };
  });
}
