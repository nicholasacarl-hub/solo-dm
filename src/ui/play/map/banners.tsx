/**
 * Two small notes in the map's action bar: the one-time first-fight tip (D65; dismissed per viewer in
 * localStorage, wrapped in try/catch, with an in-memory fallback so a throwing localStorage still remembers it for
 * the visit) and the waiting banner (D54) when the DM went idle on another creature's turn.
 */
import { useState, type ReactNode } from 'react';
import { Hourglass, Lightbulb, X } from 'lucide-react';
import { Button, IconButton } from '@/ui/components/ui';
import { usePlayView } from '../playView';
import { useIsTouch } from '../useMediaQuery';
import type { BattleMapModel } from './model';
import { firstFightTip, remindWords, waitingText } from './text';

export const TIP_STORAGE_KEY = 'solo-dm:map-tip';
let tipDismissedThisVisit = false;

export function isTipDismissed(): boolean {
  if (tipDismissedThisVisit) return true;
  try {
    return window.localStorage.getItem(TIP_STORAGE_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissTip(): void {
  tipDismissedThisVisit = true;
  try {
    window.localStorage.setItem(TIP_STORAGE_KEY, 'dismissed');
  } catch {
    // A per-viewer convenience: without storage it is remembered until the page reloads.
  }
}

/** Tests: forget this visit's dismissal. */
export function resetTipForTests(): void {
  tipDismissedThisVisit = false;
}

export function FirstFightTip({ fallback = null }: { fallback?: ReactNode }) {
  const touch = useIsTouch();
  const [dismissed, setDismissed] = useState(isTipDismissed);
  if (dismissed) return <>{fallback}</>;
  return (
    <div className="flex items-start gap-2 rounded-xl bg-info-soft py-1 pr-1 pl-3 text-xs text-info">
      <Lightbulb className="mt-1 size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 py-1 leading-snug">{firstFightTip(touch)}</p>
      <IconButton
        label="Dismiss the tip"
        size={touch ? 'md' : 'sm'}
        className="text-info hover:bg-info/10 hover:text-info"
        onClick={() => {
          dismissTip();
          setDismissed(true);
        }}
      >
        <X className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}

/**
 * "Waiting for the DM to finish Bandit 2's turn · Remind the DM" — the DM is idle, the session is on and the
 * player's view shows another creature acting (playerTurnIndex, so never a hidden one, D42).
 */
export function waitingVisible(model: BattleMapModel): boolean {
  const current = model.currentId ? model.combatants.get(model.currentId) : undefined;
  return !model.yourTurn && model.dmPhase === 'idle' && model.hasSession && !!current && !current.isPlayer;
}

export function WaitingBanner({ model }: { model: BattleMapModel }) {
  const touch = useIsTouch();
  const current = model.currentId ? model.combatants.get(model.currentId) : undefined;
  if (!waitingVisible(model) || !current) return null;
  const remind = () => {
    const view = usePlayView.getState();
    const words = remindWords(current.name);
    view.setOoc(true);
    if (view.draft.includes(words)) view.focusComposer();
    else view.appendToDraft(words);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted">
        <Hourglass className="size-4 shrink-0" aria-hidden />
        <span>{waitingText(current.name)}</span>
      </p>
      <Button size={touch ? 'lg' : 'sm'} variant="secondary" onClick={remind}>
        Remind the DM
      </Button>
    </div>
  );
}
