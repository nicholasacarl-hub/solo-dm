/**
 * The AI Dungeon Master. The UI imports only from '@/dm'.
 *
 * The DM reads and writes game state exclusively through the game store (useGame) and reads
 * settings via getSettings() (both behind ./deps so tests can replace them). Status for the UI is
 * published on useGame().dm.
 */
import type { UsageTotals } from '@/types';
import { estimateCostUsd as estimate } from './cost';
import { deps } from './deps';
import { describeKeyCheckError } from './errors';
import { DmSessionController } from './session';

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

const controller = new DmSessionController();

export const dm: DmController = {
  beginOrResume: () => controller.beginOrResume(),
  sendPlayerMessage: (text) => controller.sendPlayerMessage(text),
  regenerate: () => controller.regenerate(),
  retry: () => controller.retry(),
  cancel: () => controller.cancel(),
  endSession: () => controller.endSession(),
  isBusy: () => controller.isBusy(),
};

/** True when dm.regenerate() would be allowed now (the last response changed no game state). */
export const canRegenerate = (): boolean => controller.regenerateProblem() === null;

/** What the X-card button sends: the DM steers away from the current content without discussion. */
export const X_CARD_MESSAGE = '[X-card]';

/** Verify an API key with a tiny request. */
export const testApiKey = async (apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> => {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'Enter an API key first.' };
  try {
    await deps().keyClient(key).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeKeyCheckError(err) };
  }
};

/** Estimated USD cost of some usage at a model's published prices. */
export const estimateCostUsd: (usage: Omit<UsageTotals, 'estimatedCostUsd' | 'requests'>, model: string) => number = (
  usage,
  model,
) => estimate(usage, model);

export { DmSessionController } from './session';
export { buildSystemPrompt, DM_INSTRUCTIONS, type PromptInput } from './prompts';
export { buildGameState } from './state';
export { DM_TOOLS, READ_ONLY_TOOLS, TOOL_SCHEMAS, type ToolName } from './tools/definitions';
export { parseChoices, isOoc } from './narration';
export { setDmDeps, resetDmDeps, type DmDeps } from './deps';
export { MOCK_MODEL } from './mock';
