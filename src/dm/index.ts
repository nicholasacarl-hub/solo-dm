/**
 * The AI Dungeon Master. CONTRACT — implemented by the DM module. The UI imports only from '@/dm'.
 *
 * The DM reads and writes game state exclusively through the game store (useGame) and reads
 * settings via getSettings(). Status for the UI is published on useGame().dm.
 */
import type { UsageTotals } from '@/types';

const todo = (): never => {
  throw new Error('dm: not implemented');
};

export interface DmController {
  /**
   * Make sure the loaded campaign has an active session. If none exists, create one (freezing the
   * system prompt) and let the DM open it: session 1 starts the adventure from the premise; later
   * sessions open with a short "previously…" recap. No-op if a session is active.
   */
  beginOrResume(): Promise<void>;
  /** Send the player's words and run the DM until it hands the turn back. */
  sendPlayerMessage(text: string): Promise<void>;
  /** Discard the DM's last response (trimming the transcript from the end) and generate it again. */
  regenerate(): Promise<void>;
  /** Retry the last failed request. */
  retry(): Promise<void>;
  /** Abort the in-flight request (and any pending interaction). */
  cancel(): void;
  /** Ask the DM to wrap up: final journal/quest updates, then the recap. Ends the session. */
  endSession(): Promise<void>;
  isBusy(): boolean;
}

export const dm: DmController = {
  beginOrResume: todo,
  sendPlayerMessage: todo,
  regenerate: todo,
  retry: todo,
  cancel: todo,
  endSession: todo,
  isBusy: todo,
};

/** Verify an API key with a tiny request. */
export const testApiKey: (apiKey: string) => Promise<{ ok: true } | { ok: false; error: string }> = todo;

/** Estimated USD cost of some usage at a model's published prices. */
export const estimateCostUsd: (usage: Omit<UsageTotals, 'estimatedCostUsd' | 'requests'>, model: string) => number =
  todo;
