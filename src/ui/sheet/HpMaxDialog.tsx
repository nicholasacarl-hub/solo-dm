/**
 * The player's control for the Hit Point maximum: an effect such as Aid or Life Drain, or a lasting change the DM
 * agreed to. The preview runs the engine's own rule on the hero as they are now, so what it shows is what Apply does;
 * the DM hears of it through the usual sheet notice.
 */
import { useId, useState, type FormEvent } from 'react';
import type { Character, HpMaxEnds } from '@/types';
import { cn } from '@/lib/cn';
import { Button, Dialog, Field, Input, Segmented } from '@/ui/components/ui';
import { hpMaxChange } from './sheetChanges';
import type { SheetChange } from './useSheetActions';

const ENDS: { value: HpMaxEnds; label: string; hint: string }[] = [
  { value: 'long-rest', label: 'At the end of a Long Rest', hint: 'A drain, which returns to normal; Aid, whose 8 hours are over by then' },
  { value: 'when-ended', label: "When it's ended", hint: "Heroes' Feast's 24 hours, or a curse or poison a rest doesn't cure: end it with its ×" },
  {
    value: 'never',
    label: 'Never: part of my hero',
    hint: 'A boon, a ruling, or Hit Points your hero should have had. To take one back, lower it by the same amount under the same name',
  },
];

export function HpMaxDialog({
  open,
  character: c,
  onClose,
  onEdit,
}: {
  open: boolean;
  character: Character;
  onClose: () => void;
  onEdit: (change: (c: Character) => SheetChange) => void;
}) {
  const [direction, setDirection] = useState<'raise' | 'lower'>('raise');
  const [amount, setAmount] = useState('');
  const [name, setName] = useState('');
  const [ends, setEnds] = useState<HpMaxEnds | null>(null);
  const id = useId();
  const by = Number(amount);
  const given = amount.trim() !== '';
  const amountOk = given && Number.isInteger(by) && by >= 1 && by <= 999;
  // An amount given that can't be used says why (Apply stays off, so the browser never shows its own message).
  const amountProblem =
    given && !amountOk ? (by < 0 ? 'Give the amount without a minus sign: Lower lowers the maximum.' : 'The amount is a whole number from 1 to 999.') : '';
  const spec = amountOk && name.trim() && ends ? { name, change: direction === 'raise' ? by : -by, ends } : null;
  const dead = c.deathSaves.dead;
  const preview = spec && !dead ? hpMaxChange(c, spec) : null;
  const applies = !!preview?.notice;
  const dies = applies && preview.character.deathSaves.dead;
  const current = preview && preview.character.hp.current !== c.hp.current ? ` · HP ${c.hp.current} → ${preview.character.hp.current}` : '';
  const previewText = dead
    ? ''
    : amountProblem
      ? amountProblem
      : !preview
        ? 'Give an amount, a name and when it ends to see the change.'
        : !applies
          ? (preview.warning ?? '')
          : dies
            ? 'Your hero dies: a Hit Point maximum of 0 is death.'
            : `Maximum ${c.hp.max} → ${preview.character.hp.max}${current}`;

  const close = () => {
    setDirection('raise');
    setAmount('');
    setName('');
    setEnds(null);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!spec || !applies) return;
    onEdit((cur) => hpMaxChange(cur, spec));
    close();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="Hit point maximum"
      description="For an effect such as Aid or Life Drain, or a lasting change your DM agreed to. Your DM is told."
      footer={
        // The preview sits by Apply, in view however far the form scrolls on a phone; held sideways, beside the buttons
        // in two lines (scrolling past them), so the form keeps the height.
        <div className="flex w-full flex-col gap-2 phone-landscape:flex-row phone-landscape:items-center phone-landscape:gap-3">
          <p
            aria-live="polite"
            className={cn(
              'min-h-5 text-sm tabular-nums phone-landscape:max-h-10 phone-landscape:min-w-0 phone-landscape:flex-1 phone-landscape:overflow-y-auto',
              dies || amountProblem || (preview && !applies) ? 'text-danger' : 'text-muted',
            )}
          >
            {previewText}
          </p>
          <div className="flex shrink-0 justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" form={`${id}-form`} variant={dies ? 'danger' : 'primary'} disabled={!applies}>
              {dies ? 'Apply — your hero dies' : 'Apply'}
            </Button>
          </div>
        </div>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="flex flex-col gap-4">
        {dead && <p className="text-sm text-danger">Your hero is dead.</p>}
        <fieldset disabled={dead} className="flex flex-col gap-4">
          <fieldset>
            <legend className="sr-only">Raise or lower</legend>
            <Segmented
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'raise', label: 'Raise' },
                { value: 'lower', label: 'Lower' },
              ]}
            />
          </fieldset>
          <Field label="By" htmlFor={`${id}-by`}>
            <Input
              id={`${id}-by`}
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-invalid={amountProblem ? true : undefined}
            />
          </Field>
          <Field label="Name" htmlFor={`${id}-name`} hint={'The spell or effect, such as "Aid" or "Life Drain"; the same spell twice doesn\'t add up.'}>
            <Input id={`${id}-name`} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={`${id}-name-hint`} />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Ends</legend>
            {ENDS.map((o) => (
              // The whole block selects it; the radio is named by its label alone, its hint read as a description.
              <label key={o.value} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="radio"
                  name={`${id}-ends`}
                  value={o.value}
                  checked={ends === o.value}
                  onChange={() => setEnds(o.value)}
                  aria-labelledby={`${id}-${o.value}`}
                  aria-describedby={`${id}-${o.value}-hint`}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                />
                <span className="flex flex-col">
                  <span id={`${id}-${o.value}`}>{o.label}</span>
                  <span id={`${id}-${o.value}-hint`} className="text-xs text-muted">
                    {o.hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </fieldset>
      </form>
    </Dialog>
  );
}
