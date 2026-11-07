/**
 * Vitals: HP (with quick damage / heal / temp HP), AC, initiative, speed, proficiency bonus,
 * passive Perception, hit dice, Heroic Inspiration, concentration, exhaustion, conditions and —
 * at 0 HP — the death-save tracker.
 */
import { useId, useState, type FormEvent } from 'react';
import { Brain, Footprints, Heart, HeartPulse, Shield, Skull, Sparkles, Swords, X, Zap } from 'lucide-react';
import {
  conditionName,
  effectiveSpeed,
  formatModifier,
  initiativeModifier,
  passivePerception,
  proficiencyBonus,
  characterLevel,
} from '@/engine';
import { cn } from '@/lib/cn';
import type { Character } from '@/types';
import { Badge, Button } from '@/ui/components/ui';
import {
  concentrationChange,
  damageChange,
  deathSaveMarkChange,
  exhaustionChange,
  healChange,
  inspirationChange,
  removeConditionChange,
  tempHpChange,
} from './sheetChanges';
import { Pips, StatTile } from './SheetParts';
import type { SheetChange, SheetRoll } from './useSheetActions';

export interface VitalsProps {
  character: Character;
  editable: boolean;
  onEdit: (change: (c: Character) => SheetChange) => void;
  onRoll: (roll: SheetRoll) => void;
}

function hpTone(c: Character): string {
  const ratio = c.hp.max > 0 ? c.hp.current / c.hp.max : 0;
  if (ratio <= 0.25) return 'bg-danger';
  if (ratio <= 0.5) return 'bg-gold';
  return 'bg-success';
}

function HpBlock({ character: c, editable, onEdit }: Omit<VitalsProps, 'onRoll'>) {
  const [amount, setAmount] = useState('');
  const inputId = useId();
  const value = Number(amount);
  const valid = amount.trim() !== '' && Number.isInteger(value) && value >= 0;
  const total = Math.max(1, c.hp.max + c.hp.temp);
  const apply = (fn: (c: Character, n: number) => SheetChange) => {
    if (!valid) return;
    onEdit((current) => fn(current, value));
    setAmount('');
  };
  const onSubmit = (e: FormEvent) => e.preventDefault();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-muted uppercase">
          <Heart className="size-3.5 text-danger" aria-hidden /> Hit points
        </span>
        <span className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-2xl leading-none font-semibold" aria-label={`${c.hp.current} of ${c.hp.max} hit points`}>
            {c.hp.current}
            <span className="text-base font-normal text-muted"> / {c.hp.max}</span>
          </span>
          {c.hp.temp > 0 && <Badge tone="info">+{c.hp.temp} temp</Badge>}
        </span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className={cn('h-full transition-[width]', hpTone(c))} style={{ width: `${(c.hp.current / total) * 100}%` }} />
        {c.hp.temp > 0 && <div className="h-full bg-info" style={{ width: `${(c.hp.temp / total) * 100}%` }} />}
      </div>
      {editable && (
        <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-1.5">
          <label htmlFor={inputId} className="sr-only">
            Amount of damage or healing
          </label>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="HP"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={cn(
              'h-8 w-16 shrink-0 rounded-lg border border-border bg-surface px-2 text-center text-sm tabular-nums',
              'placeholder:text-faint focus:border-accent focus:outline-none',
              '[-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            )}
          />
          <Button size="sm" variant="danger" disabled={!valid} onClick={() => apply(damageChange)} icon={<Swords className="size-3.5 @max-sm:hidden" aria-hidden />}>
            Damage
          </Button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => apply(healChange)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-success px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <HeartPulse className="size-3.5 @max-sm:hidden" aria-hidden />
            Heal
          </button>
          <Button size="sm" variant="ghost" disabled={!valid} onClick={() => apply(tempHpChange)} title="Set temporary hit points">
            Temp
          </Button>
        </form>
      )}
    </div>
  );
}

function hitDiceText(c: Character): { value: string; sub: string } {
  if (!c.hitDice.length) return { value: '—', sub: 'Hit dice' };
  const left = c.hitDice.reduce((n, h) => n + (h.total - h.spent), 0);
  const total = c.hitDice.reduce((n, h) => n + h.total, 0);
  return { value: `${left}/${total}`, sub: c.hitDice.map((h) => `d${h.die}`).join(' · ') };
}

function DeathSaves({ character: c, editable, onEdit, onRoll }: VitalsProps) {
  const { successes, failures, stable, dead } = c.deathSaves;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-danger/40 bg-danger-soft/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-danger">
          <Skull className="size-4" aria-hidden /> Death saving throws
        </span>
        {dead ? <Badge tone="danger">Dead</Badge> : stable ? <Badge tone="success">Stable</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="text-muted">Successes</span>
          <Pips
            total={3}
            filled={successes}
            tone="success"
            label="Death save successes"
            onToggle={editable ? (fill) => onEdit((cur) => deathSaveMarkChange(cur, 'successes', cur.deathSaves.successes + (fill ? 1 : -1))) : undefined}
          />
        </span>
        <span className="flex items-center gap-2">
          <span className="text-muted">Failures</span>
          <Pips
            total={3}
            filled={failures}
            tone="danger"
            label="Death save failures"
            onToggle={editable ? (fill) => onEdit((cur) => deathSaveMarkChange(cur, 'failures', cur.deathSaves.failures + (fill ? 1 : -1))) : undefined}
          />
        </span>
        {editable && !dead && !stable && (
          <Button size="sm" variant="secondary" onClick={() => onRoll({ label: 'Death saving throw', kind: 'd20', modifier: 0 })}>
            Roll death save
          </Button>
        )}
      </div>
    </div>
  );
}

function Exhaustion({ character: c, editable, onEdit }: Omit<VitalsProps, 'onRoll'>) {
  const levels = [1, 2, 3, 4, 5, 6];
  return (
    <div className="flex items-center gap-2" role="group" aria-label={`Exhaustion level ${c.exhaustion} of 6`}>
      <span className="text-xs text-muted">Exhaustion</span>
      <div className="flex items-center gap-1">
        {levels.map((lvl) => {
          const on = lvl <= c.exhaustion;
          const dot = <span aria-hidden className={cn('block size-3 rounded-sm border-2', on ? 'border-danger bg-danger' : 'border-border')} />;
          if (!editable) return <span key={lvl}>{dot}</span>;
          const target = lvl === c.exhaustion ? lvl - 1 : lvl;
          return (
            <button
              key={lvl}
              type="button"
              aria-label={`Set exhaustion to ${target}`}
              title={`Set exhaustion to ${target}`}
              onClick={() => onEdit((cur) => exhaustionChange(cur, target))}
              className="-m-0.5 rounded p-0.5 hover:bg-surface-2"
            >
              {dot}
            </button>
          );
        })}
      </div>
      {c.exhaustion > 0 && <span className="text-xs text-danger tabular-nums">{-2 * c.exhaustion} to d20 tests</span>}
    </div>
  );
}

export function VitalsPanel(props: VitalsProps) {
  const { character: c, editable, onEdit } = props;
  const speed = effectiveSpeed(c);
  const hd = hitDiceText(c);
  const concentration = c.spellcasting?.concentratingOn;
  return (
    <div className="flex flex-col gap-3">
      <HpBlock {...props} />
      {c.hp.current === 0 && <DeathSaves {...props} />}
      <div className="grid grid-cols-3 gap-1.5 @lg:grid-cols-6">
        <StatTile label="AC" value={c.armorClass} icon={<Shield className="size-3" aria-hidden />} title={c.acFormula} />
        <StatTile label="Init" value={formatModifier(initiativeModifier(c))} icon={<Zap className="size-3" aria-hidden />} title="Initiative" />
        <StatTile
          label="Speed"
          value={speed}
          icon={<Footprints className="size-3" aria-hidden />}
          sub={speed !== c.speed ? `base ${c.speed}` : 'ft.'}
          className={speed < c.speed ? 'border-danger/50' : undefined}
        />
        <StatTile label="Prof" value={formatModifier(proficiencyBonus(characterLevel(c)))} title="Proficiency Bonus" />
        <StatTile label="Passive" value={passivePerception(c)} sub="Perception" title="Passive Perception" />
        <StatTile label="Hit dice" value={hd.value} sub={hd.sub} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          disabled={!editable}
          aria-pressed={c.heroicInspiration}
          onClick={() => onEdit((cur) => inspirationChange(cur, !cur.heroicInspiration))}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-default',
            c.heroicInspiration ? 'border-transparent bg-gold-soft text-gold' : 'border-border text-faint enabled:hover:text-text',
          )}
          title={c.heroicInspiration ? 'Heroic Inspiration: reroll any die once' : 'No Heroic Inspiration'}
        >
          <Sparkles className="size-3.5" aria-hidden />
          Inspiration
        </button>
        {concentration && (
          <span className="inline-flex items-center gap-1 rounded-full bg-arcane-soft py-1 pr-1 pl-2.5 text-xs font-medium text-arcane">
            <Brain className="size-3.5" aria-hidden />
            <span>Concentrating: {concentration}</span>
            {editable && (
              <button
                type="button"
                aria-label={`End concentration on ${concentration}`}
                title="End concentration"
                onClick={() => onEdit((cur) => concentrationChange(cur, null))}
                className="grid size-5 place-items-center rounded-full hover:bg-arcane/20"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        )}
        <Exhaustion {...props} />
      </div>
      {c.conditions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Conditions">
          {c.conditions.map((cond) => (
            <li key={cond.id} className="inline-flex items-center gap-1 rounded-full bg-danger-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-danger">
              <span title={[cond.source, cond.duration].filter(Boolean).join(' · ') || undefined}>{conditionName(cond.id)}</span>
              {editable && (
                <button
                  type="button"
                  aria-label={`Remove ${conditionName(cond.id)}`}
                  onClick={() => onEdit((cur) => removeConditionChange(cur, cond.id))}
                  className="grid size-5 place-items-center rounded-full hover:bg-danger/20"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
