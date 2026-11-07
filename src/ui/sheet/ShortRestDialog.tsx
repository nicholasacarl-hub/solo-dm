/**
 * Lets the player choose hit dice to spend during a short rest (the DM's take_rest tool waits on it).
 * Each die rolls 1d<die> + CON (minimum 1 HP, SRD 5.2.1 "Short Rest"); in physical-dice mode the
 * player types each die's result instead.
 */
import { useId, useState, type FormEvent } from 'react';
import { Coffee, Dices, HeartPulse, Undo2 } from 'lucide-react';
import { manualRollResult, rollDice } from '@/engine';
import { useGame } from '@/state/gameStore';
import type { HitDie, InteractionRequest, RollResult, ShortRestResponse } from '@/types';
import { Badge, Button, Dialog, Input } from '@/ui/components/ui';

export interface ShortRestDialogProps {
  request: Extract<InteractionRequest, { kind: 'short-rest' }>;
  onDone: (response: ShortRestResponse) => void;
  onCancel: () => void;
}

type Spent = ShortRestResponse['spent'][number];

/** "1d8+2", "1d6-1", "1d10". */
export function hitDieExpression(die: number, conMod: number): string {
  return `1d${die}${conMod > 0 ? `+${conMod}` : conMod < 0 ? `${conMod}` : ''}`;
}

/** SRD 5.2.1: you regain HP equal to the roll + CON (minimum of 1 HP per die). */
export function healedBy(roll: RollResult): number {
  return Math.max(1, roll.total);
}

function signed(n: number): string {
  return n < 0 ? `− ${Math.abs(n)}` : `+ ${n}`;
}

function PhysicalEntry({ die, onRoll }: { die: number; onRoll: (face: number) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 1 || n > die) {
      setError(`A d${die} shows a number from 1 to ${die}.`);
      return;
    }
    setError(null);
    setValue('');
    onRoll(n);
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Your d{die} result
        </label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={1}
          max={die}
          placeholder={`d${die}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 w-20 tabular-nums"
        />
        <Button type="submit" size="sm" variant="secondary">
          Spend
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

export function ShortRestDialog({ request, onDone, onCancel }: ShortRestDialogProps) {
  const mode = useGame((s) => s.campaign?.settings.playerRollMode ?? 'prompt');
  const hp = useGame((s) => s.character?.hp ?? null);
  const [spent, setSpent] = useState<Spent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const physical = mode === 'physical';
  const { conMod } = request;

  const remaining = (die: number) => {
    const entry = request.hitDice.filter((h) => h.die === die).reduce((n, h) => n + h.total - h.spent, 0);
    return entry - spent.filter((s) => s.die === die).length;
  };
  const healedTotal = spent.reduce((n, s) => n + s.healed, 0);
  const projected = hp ? Math.min(hp.max, hp.current + healedTotal) : null;
  const atFull = hp !== null && projected !== null && projected >= hp.max;
  // What the rest will actually restore (healing can't exceed the HP maximum).
  const effective = hp && projected !== null ? projected - hp.current : healedTotal;
  const dice = [...new Set(request.hitDice.map((h) => h.die))].sort((a, b) => b - a) as HitDie[];

  const record = (die: number, roll: RollResult) => {
    setSpent((list) => [...list, { die, roll, healed: healedBy(roll) }]);
    setError(null);
  };
  const rollOne = (die: number) => {
    try {
      record(die, rollDice(hitDieExpression(die, conMod)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const enterOne = (die: number, face: number) => {
    try {
      record(die, manualRollResult(hitDieExpression(die, conMod), face + conMod));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      dismissible={false}
      title="Short rest"
      description={request.reason ?? 'Spend Hit Point Dice to recover. Each die heals its roll plus your Constitution modifier (at least 1).'}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel rest
          </Button>
          <Button variant="primary" icon={<Coffee className="size-4" aria-hidden />} onClick={() => onDone({ spent })}>
            {spent.length ? `Done — +${effective} HP` : 'Done'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {hp && (
          <div className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2 text-sm" aria-live="polite">
            <span className="text-muted">Hit points</span>
            <span className="font-semibold tabular-nums">
              {hp.current}
              {healedTotal > 0 && <span className="text-success"> → {projected}</span>}
              <span className="font-normal text-muted"> / {hp.max}</span>
            </span>
          </div>
        )}
        <ul className="flex flex-col gap-2" aria-label="Hit Point Dice">
          {dice.map((die) => {
            const left = remaining(die);
            return (
              <li key={die} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
                <div>
                  <span className="font-semibold">d{die}</span>
                  <span className="ml-2 text-sm text-muted tabular-nums">
                    {left} left · {signed(conMod)} CON
                  </span>
                </div>
                {left > 0 ? (
                  physical ? (
                    <PhysicalEntry die={die} onRoll={(face) => enterOne(die, face)} />
                  ) : (
                    <Button size="sm" variant="secondary" icon={<Dices className="size-4" aria-hidden />} onClick={() => rollOne(die)}>
                      Spend a d{die}
                    </Button>
                  )
                ) : (
                  <Badge>None left</Badge>
                )}
              </li>
            );
          })}
          {dice.length === 0 && <li className="text-sm text-muted">You have no Hit Point Dice.</li>}
        </ul>
        {atFull && spent.length > 0 && <p className="text-xs text-muted">You're back to full hit points.</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {spent.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Rolls</h3>
              {physical && (
                <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" aria-hidden />} onClick={() => setSpent((list) => list.slice(0, -1))}>
                  Undo last
                </Button>
              )}
            </div>
            <ol className="flex flex-col gap-1" aria-label="Hit dice spent">
              {spent.map((s, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded-lg bg-success-soft px-3 py-1.5 text-sm">
                  <span className="tabular-nums text-muted">{s.roll.breakdown}</span>
                  <span className="flex items-center gap-1 font-semibold text-success tabular-nums">
                    <HeartPulse className="size-3.5" aria-hidden />+{s.healed}
                  </span>
                </li>
              ))}
            </ol>
            <p className="text-right text-sm tabular-nums" aria-live="polite">
              Rolled healing: <span className="font-semibold text-success">{healedTotal}</span>
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
