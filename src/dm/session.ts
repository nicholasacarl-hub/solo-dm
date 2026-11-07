/**
 * Session lifecycle and the DmController: begin / resume a session (freezing the system prompt),
 * player turns, regenerate, retry, cancel, and ending a session with a recap.
 *
 * Transcript rules (see docs/DESIGN.md): every message goes through appendTranscript and is never
 * edited. Only the END is ever trimmed — to regenerate the last response, or to set aside a player
 * turn that never got a reply (cancelled, refused or failed) before a new turn is appended.
 */
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { SRD_SOURCE_ID, type Session, type UsageTotals } from '@/types';
import { AgentFailure, answerUnfinishedToolCalls, runAgentLoop, type LoopResult } from './agent';
import { deps as currentDeps, type DmDeps } from './deps';
import { describeError, isAbortError } from './errors';
import { createMockClient } from './mock';
import { parseWrapUp, playerTextForModel } from './narration';
import { buildSystemPrompt } from './prompts';
import { buildGameState } from './state';
import { READ_ONLY_TOOLS } from './tools/definitions';
import {
  appRequestKind,
  endsWithSystem,
  isTurnUnanswered,
  lastDmNarration,
  lastTurnStartIndex,
  noticesAfterLastTurn,
  owesReply,
  toolsInLastResponse,
} from './transcript';

// ---------------------------------------------------------------------------
// App-authored turns
// ---------------------------------------------------------------------------

export function openingRequest(sessionNumber: number): string {
  if (sessionNumber <= 1) {
    return `<app_request type="session_start" session="1">
This is the first session of the campaign. Open the adventure from the premise:
- Set the opening scene with set_scene (new_scene: true) and build on its result.
- Bring the hero into the situation through their senses, with a clear hook tied to the premise and, where you can, to their background or bonds.
- Record any named NPC, place or faction you introduce with update_journal. Start a clock for the main threat with update_clocks, and a quest or rumor with update_quest if one is clear.
- If the sheet lacks personal details (personality, backstory), you may ask about one of them briefly, out of character, at the very end.
End at a decision point.
</app_request>`;
  }
  return `<app_request type="session_start" session="${sessionNumber}">
Session ${sessionNumber} begins. Open with a short "Previously…" of two to four sentences drawn from the story so far, then resume play where the last session left off (call set_scene if the scene has changed). End at a decision point.
</app_request>`;
}

export const WRAP_UP_REQUEST = `<app_request type="session_end">
The player is ending the session now. Don't continue the story or ask the player anything.
1. First save anything not yet recorded: update_journal for new or changed NPCs, places, factions, items and rulings; update_quest for quest progress; update_clocks for threats that moved.
2. Then write exactly these two sections:

## Recap
A player-facing summary of this session in 80–200 words: second person, past tense — the key events, discoveries and choices, and where the hero stands now. Nothing the hero doesn't know.

## DM Notes
Private notes for your future self (the player won't see them): your plans, the secrets and truths behind the mysteries, NPC motives, what each active clock is building toward, loose threads, and where to pick up next session.
</app_request>`;

const NOTICE_HEADER = 'Notes from the app since your last turn (take them into account; mention them only if the story needs to):';

export function formatNotices(notices: readonly string[]): string {
  return `${NOTICE_HEADER}\n${notices.map((n) => `- ${n}`).join('\n')}`;
}

/** Recover the individual notices from formatNotices() text. */
export function parseNotices(text: string): string[] {
  if (!text.startsWith(NOTICE_HEADER)) return [text.trim()].filter(Boolean);
  return text
    .slice(NOTICE_HEADER.length)
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

const NO_RECAP = 'The session ended before the DM wrote a recap.';

const zeroUsage = (): UsageTotals => ({
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
});

const BUSY = 'The DM is still working on the last turn. Wait for it to finish, or press Stop.';

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

type Operation = (signal: AbortSignal) => Promise<void>;

interface Failure {
  retry: Operation;
  /** Log entries to remove before retrying: the error itself and any partial narration. */
  logIds: string[];
}

/** Don't hold up a new session for long if the rules index is slow to build. */
const SOURCE_NAMES_TIMEOUT_MS = 5000;

/** Library source display names, for the prompt (only fetched when imports are enabled). */
async function sourceNames(d: DmDeps, enabled: readonly string[]): Promise<Record<string, string>> {
  if (!enabled.some((id) => id !== SRD_SOURCE_ID)) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SOURCE_NAMES_TIMEOUT_MS);
  });
  try {
    const index = await Promise.race([d.rulesIndex(), timeout]);
    return index ? Object.fromEntries(index.sources().map((s) => [s.id, s.name])) : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

export class DmSessionController {
  private busy = false;
  private controller: AbortController | null = null;
  private failure: Failure | null = null;

  constructor(private readonly getDeps: () => DmDeps = currentDeps) {}

  private get d(): DmDeps {
    return this.getDeps();
  }

  isBusy(): boolean {
    return this.busy;
  }

  // -- running operations ----------------------------------------------------

  private async run(op: Operation, retry: Operation): Promise<void> {
    if (this.busy) throw new Error(BUSY);
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await op(controller.signal);
      this.failure = null;
      this.setIdle();
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) this.setIdle();
      else await this.recordFailure(err, retry);
    } finally {
      this.busy = false;
      if (this.controller === controller) this.controller = null;
    }
  }

  private setIdle(): void {
    this.d.store().setDmStatus({ phase: 'idle', activity: null, error: null, retryable: false });
  }

  private async recordFailure(err: unknown, retry: Operation): Promise<void> {
    const cause = err instanceof AgentFailure ? err.error : err;
    const partial = err instanceof AgentFailure ? err.partialLogIds : [];
    const friendly = describeError(cause);
    const store = this.d.store();
    store.setDmStatus({ phase: 'error', activity: null, error: friendly.text, retryable: friendly.retryable });
    const logIds = [...partial];
    try {
      if (store.campaign) logIds.push((await store.appendLog({ kind: 'error', text: friendly.text, retryable: friendly.retryable })).id);
    } catch {
      // The status bar still shows the error.
    }
    this.failure = { retry, logIds };
  }

  private loop(signal: AbortSignal, mode: 'play' | 'ending' = 'play', waitingText?: string): Promise<LoopResult> {
    const d = this.d;
    const client = d.settings().mockMode ? createMockClient(d) : d.client();
    return runAgentLoop(d, { client, signal, mode, waitingText });
  }

  // -- transcript upkeep -------------------------------------------------------

  /**
   * Make the transcript ready for a new turn: answer tool calls left hanging by a closed tab, and
   * set aside a turn that never got a reply (trimming from the end and re-queueing its notices).
   * An unanswered session opening is kept, so the DM still opens the session.
   */
  private async prepareForNewTurn(): Promise<void> {
    await answerUnfinishedToolCalls(this.d);
    const store = this.d.store();
    const transcript = store.transcript;
    if (!isTurnUnanswered(transcript)) return;
    const start = lastTurnStartIndex(transcript);
    if (appRequestKind(transcript[start].param) === 'session_start' && !endsWithSystem(transcript)) return;
    const notices = noticesAfterLastTurn(transcript).flatMap(parseNotices);
    await store.truncateTranscriptAfter(transcript[start].seq - 1);
    for (const notice of notices) store.queueDmNotice(notice);
  }

  /** Append a turn: the <game_state> block, the words, then any pending app notices. */
  private async appendTurn(text: string, playerText: string, withNotices: boolean): Promise<void> {
    const store = this.d.store();
    const campaign = store.campaign;
    if (!campaign) throw new Error('No campaign is loaded.');
    const gameState = buildGameState({
      campaign,
      character: store.character,
      combat: store.combat,
      clocks: store.clocks,
      journal: store.journal,
      playerText,
      previousNarration: lastDmNarration(store.transcript),
    });
    const messages: BetaMessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: gameState }, { type: 'text', text }] },
    ];
    const notices = withNotices ? store.takeDmNotices() : [];
    if (notices.length > 0) messages.push({ role: 'system', content: formatNotices(notices) });
    await store.appendTranscript(messages);
  }

  // -- sessions ----------------------------------------------------------------

  private async startSession(signal: AbortSignal): Promise<void> {
    const d = this.d;
    d.store().setDmStatus({ phase: 'starting', activity: 'Preparing the session…', error: null, retryable: false });
    const campaign = d.store().campaign;
    if (!campaign) throw new Error('No campaign is loaded.');
    const names = await sourceNames(d, campaign.settings.enabledSources);
    const s = d.store();
    const number = (s.campaign ?? campaign).sessionCount + 1;
    const systemPrompt = buildSystemPrompt({
      campaign: s.campaign ?? campaign,
      character: s.character,
      sessions: s.sessions,
      sessionNumber: number,
      quests: s.quests,
      journal: s.journal,
      clocks: s.clocks,
      homebrew: s.homebrew,
      combat: s.combat,
      sourceNames: names,
    });
    const session: Session = {
      id: d.newId(),
      campaignId: campaign.id,
      number,
      status: 'active',
      model: d.settings().model,
      systemPrompt,
      startedAt: d.now(),
      endedAt: null,
      recap: null,
      dmNotes: null,
      usage: zeroUsage(),
      contextTokens: 0,
    };
    await d.store().startSession(session);
    // The new prompt already reflects anything the notices described.
    d.store().takeDmNotices();
    await d.store().appendLog({ kind: 'session', event: 'start', sessionNumber: number });
    await this.appendTurn(openingRequest(number), '', false);
    await this.loop(signal, 'play', number === 1 ? 'The DM is setting the scene…' : 'The DM is recalling the story so far…');
  }

  async beginOrResume(): Promise<void> {
    const store = this.d.store();
    if (!store.campaign) throw new Error('No campaign is loaded.');
    if (store.activeSession || this.busy) return;
    const op: Operation = async (signal) => {
      if (this.d.store().activeSession) await this.respondToTranscript(signal);
      else await this.startSession(signal);
    };
    await this.run(op, op);
  }

  async sendPlayerMessage(text: string): Promise<void> {
    const words = text.trim();
    if (!words) return;
    if (!this.d.store().campaign) throw new Error('No campaign is loaded.');
    await this.run(
      async (signal) => {
        if (!this.d.store().activeSession) {
          await this.startSession(signal);
          if (signal.aborted) return;
        }
        await this.prepareForNewTurn();
        await this.d.store().appendLog({ kind: 'player', text: words });
        await this.appendTurn(playerTextForModel(words), words, true);
        await this.loop(signal);
      },
      (signal) => this.respondToTranscript(signal),
    );
  }

  /** Run the DM against the transcript as it stands (retry after a failure or a reload). */
  private async respondToTranscript(signal: AbortSignal): Promise<void> {
    const transcript = this.d.store().transcript;
    const start = lastTurnStartIndex(transcript);
    if (start >= 0 && appRequestKind(transcript[start].param) === 'session_end') {
      await this.finishEnding(signal);
      return;
    }
    await this.loop(signal);
  }

  async retry(): Promise<void> {
    if (this.busy) throw new Error(BUSY);
    const store = this.d.store();
    const failure = this.failure;
    if (failure) {
      this.failure = null;
      if (failure.logIds.length) await store.removeLog(failure.logIds);
      await this.run(failure.retry, failure.retry);
      return;
    }
    // No failure in memory (e.g. after a reload): answer the transcript if the DM owes a reply.
    if (!store.activeSession) {
      await this.beginOrResume();
      return;
    }
    if (!owesReply(store.transcript)) return;
    const staleError = [...store.log].reverse().find((e) => e.sessionId === store.activeSession?.id && (e.kind === 'error' || e.kind === 'dm' || e.kind === 'player'));
    if (staleError?.kind === 'error') await store.removeLog([staleError.id]);
    const op: Operation = (signal) => this.respondToTranscript(signal);
    await this.run(op, op);
  }

  /** Why the last DM response can't be regenerated right now, or null when it can. */
  regenerateProblem(): string | null {
    if (this.busy) return BUSY;
    const store = this.d.store();
    if (!store.activeSession) return 'There is no session in progress to regenerate.';
    const transcript = store.transcript;
    const start = lastTurnStartIndex(transcript);
    if (start < 0 || !transcript.slice(start + 1).some((m) => m.param.role === 'assistant')) {
      return "There's no DM response to regenerate yet.";
    }
    if (appRequestKind(transcript[start].param) === 'session_end') return "The session recap can't be regenerated.";
    const changing = [...new Set(toolsInLastResponse(transcript).filter((name) => !READ_ONLY_TOOLS.has(name)))];
    if (changing.length > 0) {
      return `Can't regenerate this response: the DM already changed the game in it (${changing.join(', ')}), and those results stand. Continue the story instead.`;
    }
    return null;
  }

  async regenerate(): Promise<void> {
    const problem = this.regenerateProblem();
    if (problem) throw new Error(problem);
    const store = this.d.store();
    const session = store.activeSession;
    if (!session) return;
    const transcript = store.transcript;
    const start = lastTurnStartIndex(transcript);
    const kind = appRequestKind(transcript[start].param);
    let keep = start;
    while (transcript[keep + 1]?.param.role === 'system') keep++;
    const keepSeq = transcript[keep].seq;
    const anchorKind = kind === 'session_start' ? 'session' : 'player';
    this.failure = null;
    await this.run(
      async (signal) => {
        await this.d.store().truncateTranscriptAfter(keepSeq);
        await this.removeLogAfterLast(anchorKind, session.id);
        await this.loop(signal);
      },
      (signal) => this.respondToTranscript(signal),
    );
  }

  /** Remove the display-log entries of the response being regenerated. */
  private async removeLogAfterLast(anchorKind: 'player' | 'session', sessionId: string): Promise<void> {
    const log = this.d.store().log;
    let anchor = -1;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].sessionId === sessionId && log[i].kind === anchorKind) {
        anchor = i;
        break;
      }
    }
    if (anchor < 0) return;
    const ids = log.slice(anchor + 1).filter((e) => e.sessionId === sessionId).map((e) => e.id);
    if (ids.length) await this.d.store().removeLog(ids);
  }

  cancel(): void {
    this.controller?.abort();
    const store = this.d.store();
    const pending = store.interaction;
    if (pending) store.cancelInteraction(pending.id, 'cancelled');
    if (this.busy) store.setDmStatus({ phase: 'idle', activity: null });
  }

  async endSession(): Promise<void> {
    if (this.busy) throw new Error(BUSY);
    if (!this.d.store().activeSession) return;
    this.failure = null;
    await this.run(
      async (signal) => {
        await this.prepareForNewTurn();
        const store = this.d.store();
        if (!store.transcript.some((m) => m.param.role === 'assistant')) {
          // Nothing was played in this session: close it without a recap.
          await this.closeSession(null, null);
          return;
        }
        store.setDmStatus({ phase: 'ending-session', activity: 'The DM is wrapping up the session…', error: null, retryable: false });
        await this.appendTurn(WRAP_UP_REQUEST, '', true);
        await this.finishEnding(signal);
      },
      (signal) => this.finishEnding(signal),
    );
  }

  private async finishEnding(signal: AbortSignal): Promise<void> {
    const result = await this.loop(signal, 'ending', 'The DM is writing the session recap…');
    if (result.outcome === 'cancelled' || signal.aborted) return;
    // All of the DM's text since the wrap-up request: the recap may come before its last tool calls.
    const { recap, dmNotes } = parseWrapUp(lastDmNarration(this.d.store().transcript) || result.finalText);
    await this.closeSession(recap || NO_RECAP, dmNotes);
  }

  private async closeSession(recap: string | null, dmNotes: string | null): Promise<void> {
    const store = this.d.store();
    const session = store.activeSession;
    if (!session) return;
    if (recap) await store.appendLog({ kind: 'recap', sessionNumber: session.number, text: recap });
    await store.appendLog({ kind: 'session', event: 'end', sessionNumber: session.number });
    await this.d.store().endActiveSession({ recap, dmNotes });
  }
}
