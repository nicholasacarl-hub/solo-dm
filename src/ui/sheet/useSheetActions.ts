/**
 * Player edits and unprompted rolls from the character sheet.
 *
 * Every edit goes through useGame().updateCharacter (write-through to storage) and queues a short
 * DM notice ("Player changed HP 12 → 15") so the DM hears about it on the next turn.
 */
import { useCallback } from 'react';
import { manualD20Result, manualRollResult, rollD20Test, rollDice } from '@/engine';
import { useGame } from '@/state/gameStore';
import type { Character, D20TestResult } from '@/types';
import { toast } from '@/ui/components/toast';

export interface SheetChange {
  character: Character;
  /** What to tell the DM; null when nothing changed. */
  notice: string | null;
  /** Shown to the player instead (e.g. "No level 1 spell slots left"). */
  warning?: string | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Apply a sheet edit. Resolves to the saved character, or null if saving failed. */
export function useSheetEdit(): (change: (c: Character) => SheetChange) => Promise<Character | null> {
  const updateCharacter = useGame((s) => s.updateCharacter);
  const queueDmNotice = useGame((s) => s.queueDmNotice);
  return useCallback(
    async (change) => {
      // Filled in by the update function, which runs against the store's latest character.
      const outcome: { notice: string | null; warning: string | null } = { notice: null, warning: null };
      try {
        const saved = await updateCharacter((c) => {
          const result = change(c);
          outcome.notice = result.notice;
          outcome.warning = result.warning ?? null;
          return result.character;
        });
        if (outcome.warning) toast.info(outcome.warning);
        if (outcome.notice) queueDmNotice(outcome.notice);
        return saved;
      } catch (err) {
        toast.error(`Couldn't save that change: ${errorText(err)}`);
        return null;
      }
    },
    [updateCharacter, queueDmNotice],
  );
}

/** What the player asked to roll from the sheet. */
export interface SheetRoll {
  /** e.g. "Stealth check (DEX)" — "(unprompted)" is appended in the log. */
  label: string;
  /** d20 tests use `modifier`; other rolls use `expression` (damage). */
  kind: 'd20' | 'dice';
  modifier?: number;
  expression?: string;
}

/**
 * Log an unprompted player roll, show the result briefly, and tell the DM: the DM reads the
 * transcript, not the story log, so without a notice it never hears about the roll. Pass
 * `tellDm: false` when the roll's own change already notifies (death saves).
 */
export function useLogRoll(): (roll: SheetRoll, result: D20TestResult, manual: boolean, opts?: { tellDm?: boolean }) => Promise<void> {
  const appendLog = useGame((s) => s.appendLog);
  const queueDmNotice = useGame((s) => s.queueDmNotice);
  return useCallback(
    async (roll, result, manual, opts = {}) => {
      try {
        await appendLog({ kind: 'roll', actor: 'player', purpose: `${roll.label} (unprompted)`, roll: result, secret: false, ...(manual ? { manual } : {}) });
        if (opts.tellDm !== false) {
          queueDmNotice(`The player rolled ${roll.label} on their own: ${result.total} (${result.breakdown})${manual ? ', on physical dice' : ''}.`);
        }
        toast.info(`${roll.label}: ${result.total} (${result.breakdown})`);
      } catch (err) {
        toast.error(`Couldn't log the roll: ${errorText(err)}`);
      }
    },
    [appendLog, queueDmNotice],
  );
}

/** Roll with the app's dice (tap modes). Throws DiceError for a bad expression. */
export function rollNow(roll: SheetRoll): D20TestResult {
  if (roll.kind === 'd20') return rollD20Test(roll.modifier ?? 0);
  return rollDice(roll.expression ?? '1d20');
}

/** Build the result of a physical roll: the natural d20, or the total for other dice. */
export function manualResult(roll: SheetRoll, value: number): D20TestResult {
  if (roll.kind === 'd20') return manualD20Result(value, roll.modifier ?? 0);
  return manualRollResult(roll.expression ?? '1d20', value);
}
