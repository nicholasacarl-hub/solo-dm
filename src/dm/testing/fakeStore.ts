/**
 * An in-memory GameStore for DM tests: same contract as src/state/gameStore.ts, no IndexedDB.
 * Transcript params are deep-copied on append, as persistence would.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  initialDmStatus,
  type GameStore,
  type GameStoreState,
} from '@/state/gameStore';
// By path, not through '@/state/gameStore': DM tests replace that module with a stand-in.
import { isBusyDmPhase, planHeroMoveCommit, planHeroMoveUndo } from '@/state/heroMove';
import type {
  InteractionRequest,
  InteractionResponse,
  JournalEntry,
  LogEntry,
  Quest,
  Session,
  TranscriptMessage,
  UsageTotals,
} from '@/types';

const lower = (s: string) => s.trim().toLowerCase();

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
  };
}

export type FakeGameStore = StoreApi<GameStore>;

export function createFakeGameStore(initial: Partial<GameStoreState> = {}): FakeGameStore {
  const pending = new Map<string, { request: InteractionRequest; resolve: (r: InteractionResponse) => void; reject: (e: unknown) => void }>();
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}-${++ids}`;
  const now = () => 1_700_000_100_000 + ids;

  return createStore<GameStore>()((set, get) => {
    const requireCampaign = () => {
      const c = get().campaign;
      if (!c) throw new Error('No campaign loaded');
      return c;
    };
    const replaceSession = (session: Session) => {
      set({
        sessions: get().sessions.map((s) => (s.id === session.id ? session : s)),
        activeSession: get().activeSession?.id === session.id ? (session.status === 'active' ? session : null) : get().activeSession,
      });
    };
    const firstPending = () => pending.values().next().value?.request ?? null;

    return {
      campaignId: initial.campaign?.id ?? null,
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
      heroMoveUndo: [],
      loading: false,
      loadError: null,
      ...initial,

      async loadCampaign() {},
      unloadCampaign() {},
      async reload() {},

      async updateCampaign(patch) {
        const c = requireCampaign();
        const next = typeof patch === 'function' ? patch(c) : { ...c, ...patch };
        set({ campaign: next });
        return next;
      },
      async setCharacter(character) {
        set({ character });
      },
      async updateCharacter(fn) {
        const c = get().character;
        if (!c) throw new Error('No character loaded');
        const next = { ...fn(c), updatedAt: now() };
        set({ character: next });
        return next;
      },

      async startSession(session) {
        const c = requireCampaign();
        set({
          sessions: [...get().sessions, session],
          activeSession: session,
          transcript: [],
          campaign: { ...c, activeSessionId: session.id, sessionCount: c.sessionCount + 1 },
        });
      },
      async updateSession(patch, id) {
        const target = id ? get().sessions.find((s) => s.id === id) : get().activeSession;
        if (!target) throw new Error('No session');
        const next = { ...target, ...patch };
        replaceSession(next);
        return next;
      },
      async endActiveSession(patch) {
        const active = get().activeSession;
        if (!active) return null;
        const ended: Session = { ...active, ...patch, status: 'ended', endedAt: now() };
        replaceSession(ended);
        set({ activeSession: null, transcript: [], campaign: { ...requireCampaign(), activeSessionId: null } });
        return ended;
      },

      async appendTranscript(params) {
        const session = get().activeSession;
        if (!session) throw new Error('No active session');
        const last = get().transcript.at(-1)?.seq ?? 0;
        const messages: TranscriptMessage[] = params.map((param, i) => ({
          id: nextId('tm'),
          sessionId: session.id,
          seq: last + 1 + i,
          param: JSON.parse(JSON.stringify(param)),
          createdAt: now(),
        }));
        set({ transcript: [...get().transcript, ...messages] });
        return messages;
      },
      async truncateTranscriptAfter(seq) {
        set({ transcript: get().transcript.filter((m) => m.seq <= seq) });
      },

      async appendLog(entry) {
        const c = requireCampaign();
        const full = {
          ...entry,
          id: nextId('log'),
          campaignId: c.id,
          sessionId: get().activeSession?.id ?? null,
          seq: (get().log.at(-1)?.seq ?? 0) + 1,
          createdAt: now(),
        } as LogEntry;
        set({ log: [...get().log, full] });
        return full;
      },
      async updateLog(id, patch) {
        set({ log: get().log.map((e) => (e.id === id ? ({ ...e, ...patch, id: e.id, kind: e.kind } as LogEntry) : e)) });
      },
      async removeLog(ids) {
        const drop = new Set(ids);
        set({ log: get().log.filter((e) => !drop.has(e.id)) });
      },

      async setCombat(state) {
        set({ combat: state });
      },
      // Battle map: the store's own rules (src/state/heroMove.ts) on the real engine.
      async updateCombat(fn) {
        requireCampaign();
        const combat = get().combat;
        if (!combat) throw new Error('There is no combat running.');
        const next = fn(combat);
        if (!next) throw new Error('updateCombat must return a combat state; end a fight with setCombat(null).');
        if (next !== combat) set({ combat: next });
        return next;
      },
      async commitHeroMove(req) {
        const plan = planHeroMoveCommit(get(), req);
        if (!plan.ok) return plan;
        if (!plan.changed) return { ok: true, outcome: plan.outcome };
        set({
          combat: plan.outcome.state,
          ...(plan.character && { character: { ...plan.character, updatedAt: now() } }),
          heroMoveUndo: plan.heroMoveUndo,
        });
        return { ok: true, outcome: plan.outcome };
      },
      async undoHeroMove() {
        const undo = planHeroMoveUndo(get());
        if (!undo) return false;
        set({
          combat: undo.combat,
          ...(undo.character && { character: { ...undo.character, updatedAt: now() } }),
          heroMoveUndo: undo.heroMoveUndo,
        });
        return true;
      },

      async upsertJournal(entries) {
        const c = requireCampaign();
        const sessionNumber = get().activeSession?.number ?? c.sessionCount;
        let journal = [...get().journal];
        const saved: JournalEntry[] = [];
        for (const e of entries) {
          const existing = journal.find((j) => j.kind === e.kind && lower(j.name) === lower(e.name));
          const next: JournalEntry = existing
            ? { ...existing, ...e, id: existing.id, lastSession: sessionNumber, updatedAt: now() }
            : {
                id: nextId('j'),
                campaignId: c.id,
                summary: '',
                tags: [],
                secret: false,
                firstSession: sessionNumber,
                lastSession: sessionNumber,
                createdAt: now(),
                updatedAt: now(),
                ...e,
              };
          journal = existing ? journal.map((j) => (j.id === existing.id ? next : j)) : [...journal, next];
          saved.push(next);
        }
        set({ journal });
        return saved;
      },
      async deleteJournal(id) {
        set({ journal: get().journal.filter((j) => j.id !== id) });
      },
      async upsertQuest(q) {
        const c = requireCampaign();
        const existing = get().quests.find((x) => lower(x.title) === lower(q.title));
        const next: Quest = existing
          ? { ...existing, ...q, id: existing.id, updatedAt: now() }
          : { id: nextId('q'), campaignId: c.id, status: 'active', summary: '', objectives: [], createdAt: now(), updatedAt: now(), ...q };
        set({ quests: existing ? get().quests.map((x) => (x.id === existing.id ? next : x)) : [...get().quests, next] });
        return next;
      },
      async deleteQuest(id) {
        set({ quests: get().quests.filter((q) => q.id !== id) });
      },
      async upsertClock(clock) {
        const c = requireCampaign();
        const existing = get().clocks.find((x) => lower(x.name) === lower(clock.name));
        const merged = existing
          ? { ...existing, ...clock, id: existing.id, updatedAt: now() }
          : { id: nextId('clk'), campaignId: c.id, segments: 4, filled: 0, kind: 'threat' as const, secret: false, resolved: false, createdAt: now(), updatedAt: now(), ...clock };
        const next = { ...merged, filled: Math.max(0, Math.min(merged.segments, merged.filled)) };
        set({ clocks: existing ? get().clocks.map((x) => (x.id === existing.id ? next : x)) : [...get().clocks, next] });
        return next;
      },
      async deleteClock(id) {
        set({ clocks: get().clocks.filter((c) => c.id !== id) });
      },
      async saveHomebrew(entry) {
        const others = get().homebrew.filter((h) => h.id !== entry.id);
        set({ homebrew: [...others, entry] });
        return entry;
      },
      async deleteHomebrew(id) {
        set({ homebrew: get().homebrew.filter((h) => h.id !== id) });
      },

      async addUsage(delta) {
        const c = requireCampaign();
        const active = get().activeSession;
        set({ campaign: { ...c, usage: addUsage(c.usage, delta) } });
        if (active) replaceSession({ ...active, usage: addUsage(active.usage, delta) });
      },

      setDmStatus(patch) {
        const dm = { ...get().dm, ...patch };
        // Like the store: once a DM run starts, this turn's hero moves can't be undone.
        set(isBusyDmPhase(dm.phase) && get().heroMoveUndo.length > 0 ? { dm, heroMoveUndo: [] } : { dm });
      },

      requestInteraction(request) {
        return new Promise<InteractionResponse>((resolve, reject) => {
          pending.set(request.id, { request, resolve, reject });
          set({ interaction: firstPending() });
        });
      },
      resolveInteraction(id, response) {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        set({ interaction: firstPending() });
        p.resolve(response);
      },
      cancelInteraction(id, reason) {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        set({ interaction: firstPending() });
        p.reject(new Error('cancelled', { cause: reason }));
      },

      queueDmNotice(text) {
        const notice = text.trim();
        if (notice && !get().pendingDmNotices.includes(notice)) set({ pendingDmNotices: [...get().pendingDmNotices, notice] });
      },
      takeDmNotices() {
        const notices = get().pendingDmNotices;
        set({ pendingDmNotices: [] });
        return notices;
      },
      // Structured imports: nothing to restore in the DM's tests.
      async restoreImportedText() {
        return null;
      },
    };
  });
}

/** Answer every interaction the DM opens with `respond` (e.g. a fixed roll). */
export function autoRespond(store: FakeGameStore, respond: (request: InteractionRequest) => InteractionResponse | null): () => void {
  const handled = new Set<string>();
  return store.subscribe((state) => {
    const request = state.interaction;
    if (!request || handled.has(request.id)) return;
    // Marked first: a responder may update the store itself (e.g. spend Heroic Inspiration).
    handled.add(request.id);
    const response = respond(request);
    if (!response) {
      handled.delete(request.id);
      return;
    }
    queueMicrotask(() => store.getState().resolveInteraction(request.id, response));
  });
}
