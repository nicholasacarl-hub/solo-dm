/**
 * Helpers around the DM status published on useGame().dm, and safe wrappers for calls to the DM
 * controller from UI event handlers (errors become toasts instead of unhandled rejections).
 */
import { dm } from '@/dm';
import { useGame, type DmPhase } from '@/state/gameStore';
import { toast } from '@/ui/components/toast';
import { errorMessage } from './format';

const IDLE_PHASES: readonly DmPhase[] = ['idle', 'error'];

/** True while the DM is doing something (the player should wait or press Stop). */
export function isBusyPhase(phase: DmPhase): boolean {
  return !IDLE_PHASES.includes(phase);
}

const PHASE_LABELS: Record<DmPhase, string> = {
  idle: '',
  starting: 'Setting the table…',
  thinking: 'The DM is thinking…',
  streaming: 'The DM is narrating…',
  tool: 'The DM is checking the books…',
  'waiting-player': 'The DM is waiting for you…',
  'ending-session': 'Writing the session recap…',
  error: 'The DM ran into a problem.',
};

export function phaseLabel(phase: DmPhase, activity: string | null): string {
  return activity?.trim() || PHASE_LABELS[phase];
}

/** Resolves once the DM is idle (or errored), or after `timeoutMs`. */
export function waitForDmIdle(timeoutMs = 5000): Promise<void> {
  if (!isBusyPhase(useGame.getState().dm.phase)) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const unsubscribe = useGame.subscribe((state) => {
      if (!isBusyPhase(state.dm.phase)) finish();
    });
  });
}

/** Send the player's words to the DM. Resolves false (after a toast) if the DM rejected them. */
export async function sendToDm(text: string): Promise<boolean> {
  try {
    await dm.sendPlayerMessage(text);
    return true;
  } catch (err) {
    toast.error(errorMessage(err));
    return false;
  }
}

/** Run a DM controller action from a click handler, surfacing failures as a toast. */
export async function runDm(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function cancelDm(): void {
  try {
    dm.cancel();
  } catch (err) {
    toast.error(errorMessage(err));
  }
}
