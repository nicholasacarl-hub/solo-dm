/**
 * Session lifecycle and the DmController: begin / resume a session (freezing the system prompt),
 * player turns, regenerate, retry, cancel, and ending a session with a recap.
 *
 * Transcript rules (see docs/DESIGN.md): every message goes through appendTranscript and is never
 * edited. Only the END is ever trimmed — to regenerate the last response, or to set aside a player
 * turn that never got a reply (cancelled, refused or failed) before a new turn is appended. The
 * words of a turn set aside that way go to the DM again inside the next turn (unless Claude refused
 * them), so nothing the player sees in the log is silently dropped.
 */
import type { BetaMessageParam, BetaTextBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { DmStatus } from '@/state/gameStore';
import type { Session, UsageTotals } from '@/types';
import { AgentFailure, answerUnfinishedToolCalls, NOTES, runAgentLoop, type LoopResult } from './agent';
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
  turnWords,
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
/** At a session start: changes made since the last session (the new prompt may reflect some of them). */
const SESSION_NOTICE_HEADER =
  'Notes from the app since the last session (the campaign notes above may already reflect some of them; take them into account, and act on any veto or table-rule change):';

export function formatNotices(notices: readonly string[], opts: { sessionStart?: boolean } = {}): string {
  return `${opts.sessionStart ? SESSION_NOTICE_HEADER : NOTICE_HEADER}\n${notices.map((n) => `- ${n}`).join('\n')}`;
}

/** Recover the individual notices from formatNotices() text. */
export function parseNotices(text: string): string[] {
  const header = [NOTICE_HEADER, SESSION_NOTICE_HEADER].find((h) => text.startsWith(h));
  if (!header) return [text.trim()].filter(Boolean);
  return text
    .slice(header.length)
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

const UNANSWERED_OPEN = '<unanswered_turn>';
const UNANSWERED_CLOSE = '</unanswered_turn>';
const UNANSWERED_NOTE =
  'The player sent this before their message below, but your reply was stopped (or failed) before you answered it. Take both into account; where they disagree, the newer message wins.';

/** The words of turns that never got a reply, carried into the next turn (oldest first). */
export function unansweredBlock(messages: readonly string[]): string {
  return `${UNANSWERED_OPEN}\n${UNANSWERED_NOTE}\n\n${messages.join('\n\n')}\n${UNANSWERED_CLOSE}`;
}

/** Unwrap an unansweredBlock() back into its messages (plain words come back as they are). */
export function unansweredMessages(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith(UNANSWERED_OPEN) || !trimmed.endsWith(UNANSWERED_CLOSE)) return [trimmed].filter(Boolean);
  let inner = trimmed.slice(UNANSWERED_OPEN.length, -UNANSWERED_CLOSE.length).trim();
  if (inner.startsWith(UNANSWERED_NOTE)) inner = inner.slice(UNANSWERED_NOTE.length).trim();
  return inner ? [inner] : [];
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

const IDLE: Partial<DmStatus> = { phase: 'idle', activity: null, error: null, retryable: false };

type GameStoreLog = ReturnType<DmDeps['store']>['log'];

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

type Operation = (signal: AbortSignal) => Promise<void>;

interface Failure {
  retry: Operation;
  /** Log entries to remove before retrying: the error itself and any partial narration. */
  logIds: string[];
}

/** Don't hold up a new session for long if the library is slow to read. */
const SOURCE_NAMES_TIMEOUT_MS = 5000;

/** The imported books switched on in the player's Library (the DM searches them), for the prompt. */
async function libraryImports(d: DmDeps): Promise<{ id: string; name: string }[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SOURCE_NAMES_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([d.libraryImports(), timeout])) ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The run in progress: its abort switch, and a promise that settles once it has fully unwound. */
interface CurrentRun {
  controller: AbortController;
  done: Promise<void>;
}

export class DmSessionController {
  private busy = false;
  private current: CurrentRun | null = null;
  private failure: Failure | null = null;

  constructor(private readonly getDeps: () => DmDeps = currentDeps) {}

  private get d(): DmDeps {
    return this.getDeps();
  }

  isBusy(): boolean {
    return this.busy;
  }

  // -- running operations ----------------------------------------------------

  /**
   * Run one operation at a time. The phase reads busy for the whole run, and the final status
   * ('idle' or 'error') is published only after the run has fully unwound and `busy` is false, so a
   * caller that waits for the DM to go idle (the X-card, Send right after Stop) can always start
   * the next turn.
   */
  private async run(op: Operation, retry: Operation): Promise<void> {
    await this.settleStopped();
    if (this.busy) throw new Error(BUSY);
    this.busy = true;
    const controller = new AbortController();
    let unwound!: () => void;
    const done = new Promise<void>((resolve) => {
      unwound = resolve;
    });
    this.current = { controller, done };
    // Busy from the first moment: never 'idle' (or a stale 'error') while a run is in progress.
    this.d.store().setDmStatus({ phase: 'thinking', activity: null, error: null, retryable: false });
    let status: Partial<DmStatus> | null = null;
    try {
      await op(controller.signal);
      this.failure = null;
      status = IDLE;
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) status = IDLE;
      else status = await this.recordFailure(err, retry);
    } finally {
      this.busy = false;
      if (this.current?.controller === controller) this.current = null;
      if (status) this.d.store().setDmStatus(status);
      unwound();
    }
  }

  /** Wait for a run the player stopped to finish unwinding (it saves what it streamed first). */
  private async settleStopped(): Promise<void> {
    while (this.busy && this.current?.controller.signal.aborted) await this.current.done;
  }

  /** Log the failure (with Retry) and return the status to publish once the run has unwound. */
  private async recordFailure(err: unknown, retry: Operation): Promise<Partial<DmStatus>> {
    const cause = err instanceof AgentFailure ? err.error : err;
    const partial = err instanceof AgentFailure ? err.partialLogIds : [];
    const friendly = describeError(cause);
    const store = this.d.store();
    const logIds = [...partial];
    try {
      if (store.campaign) logIds.push((await store.appendLog({ kind: 'error', text: friendly.text, retryable: friendly.retryable })).id);
    } catch {
      // The status bar still shows the error.
    }
    this.failure = { retry, logIds };
    return { phase: 'error', activity: null, error: friendly.text, retryable: friendly.retryable };
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
   * Returns the words of a set-aside player turn, to send again inside the next turn — unless Claude
   * refused them (the player was asked to rephrase). An unanswered session opening is kept, so the
   * DM still opens the session; only app notes after it are set aside (a user turn can't follow a
   * system message) and re-queued for the next turn.
   */
  private async prepareForNewTurn(): Promise<string[]> {
    await answerUnfinishedToolCalls(this.d);
    const store = this.d.store();
    const transcript = store.transcript;
    if (!isTurnUnanswered(transcript)) return [];
    const start = lastTurnStartIndex(transcript);
    const kind = appRequestKind(transcript[start].param);
    const notices = noticesAfterLastTurn(transcript).flatMap(parseNotices);
    if (kind === 'session_start') {
      if (!endsWithSystem(transcript)) return [];
      await store.truncateTranscriptAfter(transcript[start].seq);
      for (const notice of notices) store.queueDmNotice(notice);
      return [];
    }
    const carried = kind === null && !this.lastTurnRefused() ? turnWords(transcript[start].param).flatMap(unansweredMessages) : [];
    await store.truncateTranscriptAfter(transcript[start].seq - 1);
    for (const notice of notices) store.queueDmNotice(notice);
    return carried;
  }

  /** Log entries of the active session since its last player message (or since it started). */
  private logSinceLastTurn(): GameStoreLog {
    const store = this.d.store();
    const sessionId = store.activeSession?.id;
    const log = store.log;
    let i = log.length - 1;
    while (i >= 0 && !(log[i].sessionId === sessionId && (log[i].kind === 'player' || log[i].kind === 'session'))) i--;
    return log.slice(i + 1).filter((e) => e.sessionId === sessionId);
  }

  /** Claude refused the latest turn: its words were set aside for the player to rephrase. */
  private lastTurnRefused(): boolean {
    return this.logSinceLastTurn().some((e) => e.kind === 'system' && e.text === NOTES.refusedTurn);
  }

  /** The player stopped the DM's reply mid-stream since their last message. */
  private stoppedSinceLastTurn(): boolean {
    return this.logSinceLastTurn().some((e) => e.kind === 'system' && e.text === NOTES.stopped);
  }

  /**
   * Append a turn: the <game_state> block, the words of any turn that never got a reply, the new
   * words, then the pending app notices (plus `extraNotices`) as a system message.
   */
  private async appendTurn(
    text: string,
    playerText: string,
    withNotices: boolean,
    opts: { carried?: readonly string[]; extraNotices?: readonly string[]; sessionStart?: boolean } = {},
  ): Promise<void> {
    const store = this.d.store();
    const campaign = store.campaign;
    if (!campaign) throw new Error('No campaign is loaded.');
    const carried = opts.carried ?? [];
    const gameState = buildGameState({
      campaign,
      character: store.character,
      combat: store.combat,
      clocks: store.clocks,
      journal: store.journal,
      playerText: [...carried, playerText].filter(Boolean).join('\n'),
      previousNarration: lastDmNarration(store.transcript),
    });
    const content: BetaTextBlockParam[] = [{ type: 'text', text: gameState }];
    if (carried.length > 0) content.push({ type: 'text', text: unansweredBlock(carried) });
    content.push({ type: 'text', text });
    const messages: BetaMessageParam[] = [{ role: 'user', content }];
    const notices = [...(withNotices ? store.takeDmNotices() : []), ...(opts.extraNotices ?? [])];
    if (notices.length > 0) messages.push({ role: 'system', content: formatNotices(notices, { sessionStart: opts.sessionStart }) });
    await store.appendTranscript(messages);
  }

  // -- sessions ----------------------------------------------------------------

  private async startSession(signal: AbortSignal): Promise<void> {
    const d = this.d;
    d.store().setDmStatus({ phase: 'starting', activity: 'Preparing the session…', error: null, retryable: false });
    const campaign = d.store().campaign;
    if (!campaign) throw new Error('No campaign is loaded.');
    const imports = await libraryImports(d);
    if (signal.aborted) return;
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
      librarySources: imports,
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
    await d.store().appendLog({ kind: 'session', event: 'start', sessionNumber: number });
    // Pending notices go with the opening: the new prompt doesn't reflect all of them (a homebrew
    // veto, for one, leaves the entry listed as in play until the DM retires it).
    await this.appendTurn(openingRequest(number), '', true, { sessionStart: true });
    await this.loop(signal, 'play', number === 1 ? 'The DM is setting the scene…' : 'The DM is recalling the story so far…');
  }

  async beginOrResume(): Promise<void> {
    const store = this.d.store();
    if (!store.campaign) throw new Error('No campaign is loaded.');
    await this.settleStopped();
    if (this.busy) return;
    // An active session needs nothing — unless its opening never got a reply (the page reloaded or
    // the table closed mid-opening). Other unanswered turns wait for Retry or the player's next words.
    if (store.activeSession && !this.openingUnanswered()) return;
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
        const carried = await this.prepareForNewTurn();
        const stopped = this.stoppedSinceLastTurn();
        await this.d.store().appendLog({ kind: 'player', text: words });
        await this.appendTurn(playerTextForModel(words), words, true, {
          carried,
          extraNotices: stopped ? [NOTES.stoppedNotice] : [],
        });
        await this.loop(signal);
      },
      (signal) => this.respondToTranscript(signal),
    );
  }

  /** True when the active session's opening request is still waiting for the DM's first reply. */
  private openingUnanswered(): boolean {
    const transcript = this.d.store().transcript;
    if (!isTurnUnanswered(transcript) || !owesReply(transcript)) return false;
    const start = lastTurnStartIndex(transcript);
    return start >= 0 && appRequestKind(transcript[start].param) === 'session_start';
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
    await this.settleStopped();
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
    await this.settleStopped();
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

  /**
   * Stop the run in progress. The status stays busy ("Stopping…") until the run has unwound — it
   * saves what it streamed first — and run() then publishes 'idle'; a send made meanwhile waits for
   * it instead of failing.
   */
  cancel(): void {
    this.current?.controller.abort();
    const store = this.d.store();
    const pending = store.interaction;
    if (pending) store.cancelInteraction(pending.id, 'cancelled');
    if (this.busy) store.setDmStatus({ activity: 'Stopping…' });
  }

  async endSession(): Promise<void> {
    await this.settleStopped();
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
