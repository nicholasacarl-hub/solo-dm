/**
 * An in-memory stand-in for the game store's actions, seeded with the shared fixtures. Used by the
 * dev preview (no IndexedDB, no DM) and by tests (wrapped in spies). Not shipped: nothing in the
 * app imports it.
 */
import { initialDmStatus, useGame, type GameStoreActions, type GameStoreState } from '@/state/gameStore';
import {
  sampleCampaign,
  sampleCharacter,
  sampleClocks,
  sampleCombat,
  sampleJournal,
  sampleLog,
  sampleQuests,
  sampleSession,
} from '@/test/fixtures';
import type { HomebrewEntry, InteractionResponse, JournalEntry, LogEntry, Quest } from '@/types';

export function sampleHomebrew(): HomebrewEntry[] {
  return [
    {
      id: 'hb-1',
      sourceId: 'homebrew',
      sourceName: 'Homebrew',
      campaignId: 'camp-1',
      origin: 'dm',
      kind: 'boon',
      name: "Tidecaller's Mark",
      summary: 'Once per long rest, breathe water for 10 minutes.',
      text: 'While the mark glows you can breathe underwater and have a Swim Speed equal to your Speed. **Once per Long Rest**, for 10 minutes.',
      basedOn: { name: 'Water Breathing' },
      balanceNotes: 'Narrower than the 3rd-level spell: self only, shorter duration.',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    },
  ];
}

/** Every fixture the Play screen shows, as one store state patch. */
export function fixtureState(): Partial<GameStoreState> {
  const session = sampleSession();
  const ended = sampleSession({
    id: 'sess-0',
    number: 1,
    status: 'ended',
    endedAt: 1_699_900_000_000,
    recap:
      'You arrived in **Saltmarsh** as the old lantern relit itself, and Old Tam swore he saw a figure on the gallery.',
    dmNotes: 'Halvard is alive, bound beneath the breakwater.',
  });
  return {
    campaignId: 'camp-1',
    campaign: sampleCampaign({ sessionCount: 2 }),
    character: sampleCharacter(),
    sessions: [ended, { ...session, number: 2 }],
    activeSession: { ...session, number: 2 },
    transcript: [],
    log: sampleLog(),
    combat: sampleCombat(),
    journal: sampleJournal(),
    quests: sampleQuests(),
    clocks: sampleClocks(),
    homebrew: sampleHomebrew(),
    dm: initialDmStatus,
    interaction: null,
    pendingDmNotices: [],
    loading: false,
    loadError: null,
  };
}

type Pending = { resolve: (r: InteractionResponse) => void; reject: (e: Error) => void };

/** Fake actions that update useGame in memory, mirroring the contract's semantics closely enough for the UI. */
export function createFakeActions(): GameStoreActions {
  const set = useGame.setState;
  const get = useGame.getState;
  const pending = new Map<string, Pending>();
  let seq = 1000;

  const requireCampaign = () => {
    const campaign = get().campaign;
    if (!campaign) throw new Error('No campaign is loaded.');
    return campaign;
  };

  return {
    async loadCampaign(id) {
      set({ ...fixtureState(), campaignId: id });
    },
    unloadCampaign() {
      set({ campaignId: null, campaign: null, character: null, log: [], activeSession: null, sessions: [] });
    },
    async reload() {},
    async updateCampaign(patch) {
      const current = requireCampaign();
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      set({ campaign: next });
      return next;
    },
    async setCharacter(character) {
      set({ character });
    },
    async updateCharacter(fn) {
      const current = get().character;
      if (!current) throw new Error('No character is loaded.');
      const next = fn(current);
      set({ character: next });
      return next;
    },
    async startSession(session) {
      set({ activeSession: session, sessions: [...get().sessions, session] });
    },
    async updateSession(patch) {
      const current = get().activeSession;
      if (!current) throw new Error('No active session.');
      const next = { ...current, ...patch };
      set({ activeSession: next, sessions: get().sessions.map((s) => (s.id === next.id ? next : s)) });
      return next;
    },
    async endActiveSession(patch) {
      const current = get().activeSession;
      if (!current) return null;
      const ended = { ...current, ...patch, status: 'ended' as const, endedAt: Date.now() };
      set({ activeSession: null, sessions: get().sessions.map((s) => (s.id === ended.id ? ended : s)) });
      return ended;
    },
    async appendTranscript() {
      return [];
    },
    async truncateTranscriptAfter() {},
    async appendLog(entry) {
      seq += 1;
      const full = {
        ...entry,
        id: `fake-log-${seq}`,
        seq,
        campaignId: get().campaignId ?? 'camp-1',
        sessionId: get().activeSession?.id ?? null,
        createdAt: Date.now(),
      } as LogEntry;
      set({ log: [...get().log, full] });
      return full;
    },
    async updateLog(id, patch) {
      set({ log: get().log.map((e) => (e.id === id ? ({ ...e, ...patch } as LogEntry) : e)) });
    },
    async removeLog(ids) {
      set({ log: get().log.filter((e) => !ids.includes(e.id)) });
    },
    async setCombat(state) {
      set({ combat: state });
    },
    async upsertJournal(entries) {
      const journal = [...get().journal];
      const saved: JournalEntry[] = [];
      for (const upsert of entries) {
        const index = journal.findIndex(
          (e) => e.kind === upsert.kind && e.name.toLowerCase() === upsert.name.toLowerCase(),
        );
        const base: JournalEntry =
          index >= 0
            ? journal[index]
            : {
                id: `fake-j-${++seq}`,
                campaignId: 'camp-1',
                summary: '',
                tags: [],
                secret: false,
                firstSession: 1,
                lastSession: 1,
                createdAt: 0,
                updatedAt: 0,
                ...upsert,
              };
        const next = { ...base, ...upsert, updatedAt: Date.now() } as JournalEntry;
        if (index >= 0) journal[index] = next;
        else journal.push(next);
        saved.push(next);
      }
      set({ journal });
      return saved;
    },
    async deleteJournal(id) {
      set({ journal: get().journal.filter((e) => e.id !== id) });
    },
    async upsertQuest(upsert) {
      const quests = get().quests;
      const existing = quests.find(
        (q) => (upsert.id && q.id === upsert.id) || q.title.toLowerCase() === upsert.title.toLowerCase(),
      );
      const next: Quest = existing
        ? { ...existing, ...upsert, updatedAt: Date.now() }
        : {
            id: `fake-q-${++seq}`,
            campaignId: 'camp-1',
            status: 'active',
            summary: '',
            objectives: [],
            createdAt: 0,
            updatedAt: 0,
            ...upsert,
          };
      set({ quests: existing ? quests.map((q) => (q.id === next.id ? next : q)) : [...quests, next] });
      return next;
    },
    async deleteQuest(id) {
      set({ quests: get().quests.filter((q) => q.id !== id) });
    },
    async upsertClock(upsert) {
      const clocks = get().clocks;
      const existing = clocks.find(
        (c) => (upsert.id && c.id === upsert.id) || c.name.toLowerCase() === upsert.name.toLowerCase(),
      );
      const next = existing
        ? { ...existing, ...upsert }
        : {
            id: `fake-c-${++seq}`,
            campaignId: 'camp-1',
            segments: 4,
            filled: 0,
            kind: 'threat' as const,
            secret: false,
            resolved: false,
            createdAt: 0,
            updatedAt: 0,
            ...upsert,
          };
      set({ clocks: existing ? clocks.map((c) => (c.id === next.id ? next : c)) : [...clocks, next] });
      return next;
    },
    async deleteClock(id) {
      set({ clocks: get().clocks.filter((c) => c.id !== id) });
    },
    async saveHomebrew(entry) {
      const homebrew = get().homebrew.filter((h) => h.id !== entry.id);
      set({ homebrew: [...homebrew, entry] });
      return entry;
    },
    async deleteHomebrew(id) {
      set({ homebrew: get().homebrew.filter((h) => h.id !== id) });
    },
    async addUsage() {},
    setDmStatus(patch) {
      set({ dm: { ...get().dm, ...patch } });
    },
    requestInteraction(request) {
      return new Promise<InteractionResponse>((resolve, reject) => {
        pending.set(request.id, { resolve, reject });
        set({ interaction: request });
      });
    },
    resolveInteraction(id, response) {
      pending.get(id)?.resolve(response);
      pending.delete(id);
      if (get().interaction?.id === id) set({ interaction: null });
    },
    cancelInteraction(id, reason) {
      pending.get(id)?.reject(new Error(reason ?? 'cancelled'));
      pending.delete(id);
      if (get().interaction?.id === id) set({ interaction: null });
    },
    queueDmNotice(text) {
      set({ pendingDmNotices: [...get().pendingDmNotices, text] });
    },
    takeDmNotices() {
      const notices = get().pendingDmNotices;
      set({ pendingDmNotices: [] });
      return notices;
    },
  };
}
