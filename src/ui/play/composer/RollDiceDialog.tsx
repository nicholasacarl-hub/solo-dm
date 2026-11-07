import { useId, useState, type FormEvent } from 'react';
import { Dices } from 'lucide-react';
import { rollDice } from '@/engine';
import { useGame } from '@/state/gameStore';
import type { RollResult } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, Dialog, Field, Input } from '@/ui/components/ui';
import { errorMessage } from '../format';

const QUICK_DICE = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];

/**
 * "Roll a die yourself": rolls with the app's dice, logs the roll, and tells the DM next turn.
 */
export function RollDiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [expression, setExpression] = useState('1d20');
  const [purpose, setPurpose] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const formId = useId();
  const exprId = useId();
  const purposeId = useId();

  const roll = async (e?: FormEvent) => {
    e?.preventDefault();
    const expr = expression.trim();
    if (!expr) {
      setError('Enter some dice, for example 1d20 or 2d6+3.');
      return;
    }
    let result: RollResult;
    try {
      result = rollDice(expr);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    const what = purpose.trim();
    setRolling(true);
    try {
      const { appendLog, queueDmNotice } = useGame.getState();
      await appendLog({ kind: 'roll', actor: 'player', purpose: what || `Rolled ${result.expression}`, roll: result, secret: false });
      queueDmNotice(`The player rolled ${result.expression}${what ? ` for "${what}"` : ''} on their own: ${result.breakdown}.`);
      setError(null);
      setPurpose('');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRolling(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Roll dice"
      description="Rolled with the app's dice and shown to the DM on your next turn."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={rolling} icon={<Dices className="size-4" aria-hidden />}>
            Roll
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void roll(e)} className="flex flex-col gap-4">
        <Field label="Dice" htmlFor={exprId} error={error ?? undefined} hint="For example 1d20+3, 2d6, 4d6kh3.">
          <Input
            id={exprId}
            value={expression}
            onChange={(e) => {
              setExpression(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            className="font-mono"
            aria-invalid={error ? true : undefined}
          />
        </Field>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick dice">
          {QUICK_DICE.map((die) => (
            <button
              key={die}
              type="button"
              onClick={() => {
                setExpression(`1${die}`);
                setError(null);
              }}
              className="rounded-lg border border-border px-2.5 py-1 font-mono text-xs text-muted hover:bg-surface-2 hover:text-text"
            >
              {die}
            </button>
          ))}
        </div>
        <Field label="What's it for?" htmlFor={purposeId} hint="Optional.">
          <Input
            id={purposeId}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="Searching the wreck"
            autoComplete="off"
          />
        </Field>
      </form>
    </Dialog>
  );
}
