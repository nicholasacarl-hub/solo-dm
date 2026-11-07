/**
 * Combat tab: attacks (bonus and damage from the engine) and the conditions list.
 */
import { useId, useState } from 'react';
import { Dices, Plus } from 'lucide-react';
import { attackBonus, attackDamageExpression, conditionName, formatModifier, rollRequestModifier } from '@/engine';
import { CONDITION_IDS, type Attack, type Character } from '@/types';
import { Badge, Button, EmptyState, Select } from '@/ui/components/ui';
import { addConditionChange, removeConditionChange } from './sheetChanges';
import { SheetSection } from './SheetParts';
import type { SheetChange, SheetRoll } from './useSheetActions';

function attackRoll(c: Character, attack: Attack): SheetRoll {
  const { modifier, label } = rollRequestModifier(c, {
    rollType: 'attack',
    attackName: attack.name,
    revealDc: false,
    advantage: 'normal',
    reason: 'Unprompted roll',
  });
  return { kind: 'd20', modifier, label };
}

function damageRoll(c: Character, attack: Attack): SheetRoll {
  return { kind: 'dice', expression: attackDamageExpression(c, attack), label: `${attack.name} damage` };
}

function AttackRow({ c, attack, onRoll }: { c: Character; attack: Attack; onRoll?: (roll: SheetRoll) => void }) {
  const mastered = Boolean(attack.mastery);
  const bonus = formatModifier(attackBonus(c, attack));
  const damage = attackDamageExpression(c, attack);
  const details = [attack.range, ...(attack.properties ?? [])].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-col gap-1 rounded-xl border border-border bg-surface-2 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{attack.name}</span>
        {mastered && (
          <Badge tone="accent" className="shrink-0">
            {attack.mastery}
          </Badge>
        )}
        {!attack.proficient && <Badge className="shrink-0">Not proficient</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {onRoll ? (
          <button
            type="button"
            onClick={() => onRoll(attackRoll(c, attack))}
            aria-label={`Roll ${attack.name} attack, ${bonus} to hit`}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-0.5 font-semibold tabular-nums hover:border-accent hover:text-accent"
          >
            <Dices className="size-3.5" aria-hidden /> {bonus}
          </button>
        ) : (
          <span className="font-semibold tabular-nums">{bonus} to hit</span>
        )}
        {onRoll ? (
          <button
            type="button"
            onClick={() => onRoll(damageRoll(c, attack))}
            aria-label={`Roll ${attack.name} damage, ${damage}`}
            className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-0.5 tabular-nums hover:border-danger hover:text-danger"
          >
            <Dices className="size-3.5" aria-hidden /> {damage}
          </button>
        ) : (
          <span className="tabular-nums">{damage}</span>
        )}
        <span className="text-muted">{attack.damageType}</span>
      </div>
      {(details || attack.notes) && <p className="text-xs text-faint">{[details, attack.notes].filter(Boolean).join(' · ')}</p>}
    </li>
  );
}

function ConditionsEditor({ character: c, onEdit }: { character: Character; onEdit: (change: (c: Character) => SheetChange) => void }) {
  const [choice, setChoice] = useState('');
  const id = useId();
  const available = CONDITION_IDS.filter((cid) => cid !== 'exhaustion' && !c.conditions.some((x) => x.id === cid));
  return (
    <div className="flex flex-col gap-2">
      {c.conditions.length === 0 ? (
        <p className="text-sm text-muted">No conditions.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {c.conditions.map((cond) => (
            <li key={cond.id} className="flex items-center justify-between gap-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm">
              <span>
                <span className="font-medium text-danger">{conditionName(cond.id)}</span>
                {(cond.source || cond.duration) && <span className="text-muted"> · {[cond.source, cond.duration].filter(Boolean).join(' · ')}</span>}
              </span>
              <Button size="sm" variant="ghost" onClick={() => onEdit((cur) => removeConditionChange(cur, cond.id))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="sr-only">
          Add a condition
        </label>
        <Select id={id} value={choice} onChange={(e) => setChoice(e.target.value)} className="h-9">
          <option value="">Add a condition…</option>
          {available.map((cid) => (
            <option key={cid} value={cid}>
              {conditionName(cid)}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={!choice}
          icon={<Plus className="size-4" aria-hidden />}
          onClick={() => {
            onEdit((cur) => addConditionChange(cur, choice));
            setChoice('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export function CombatPanel({
  character,
  editable,
  onEdit,
  onRoll,
}: {
  character: Character;
  editable: boolean;
  onEdit: (change: (c: Character) => SheetChange) => void;
  onRoll?: (roll: SheetRoll) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <SheetSection title="Attacks">
        {character.attacks.length ? (
          <ul className="flex flex-col gap-1.5">
            {character.attacks.map((a) => (
              <AttackRow key={a.id} c={character} attack={a} onRoll={onRoll} />
            ))}
          </ul>
        ) : (
          <EmptyState title="No attacks yet" className="py-4">
            Equip a weapon or learn an attack cantrip.
          </EmptyState>
        )}
      </SheetSection>
      <SheetSection title="Conditions">
        {editable ? (
          <ConditionsEditor character={character} onEdit={onEdit} />
        ) : (
          <p className="text-sm text-muted">{character.conditions.map((x) => conditionName(x.id)).join(', ') || 'No conditions.'}</p>
        )}
      </SheetSection>
    </div>
  );
}
