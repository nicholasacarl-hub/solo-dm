/**
 * Vitals: HP (with quick damage / heal / temp HP), AC (and the spells it counts), initiative, speed,
 * proficiency bonus, passive Perception, hit dice, Heroic Inspiration, concentration, exhaustion,
 * conditions and — at 0 HP — the death-save tracker.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Brain, Footprints, Heart, HeartPulse, Pencil, Shield, Skull, Sparkles, Swords, X, Zap } from 'lucide-react';
import {
  AC_SPELLS,
  acSpellNamed,
  acSpells,
  conditionName,
  countedAcSpells,
  effectiveSpeed,
  formatModifier,
  hpMaxAdjustments,
  hpMaxEndsText,
  initiativeModifier,
  passivePerception,
  proficiencyBonus,
  characterLevel,
} from '@/engine';
import { cn } from '@/lib/cn';
import type { AcSpellName, Character, HpMaxAdjustment } from '@/types';
import { Badge, Button, IconButton } from '@/ui/components/ui';
import { HpMaxDialog } from './HpMaxDialog';
import {
  concentrationChange,
  damageChange,
  deathSaveMarkChange,
  endAcSpellChange,
  endHpMaxChange,
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

const ENDS_TITLE: Record<HpMaxAdjustment['ends'], string> = {
  'long-rest': 'Ends at a Long Rest',
  'when-ended': 'Ends when you or your DM end it',
  never: 'Lasting: part of your hero',
};

/**
 * What changes the maximum beyond the app's own count: raises, reductions and lasting changes, each in its tone and
 * saying when it ends. An effect's × ends it; focus then goes to the × now in its place, else the one before, else the
 * pencil (`pencil`), never to the page. Chips are keyed by what they are, so one ended elsewhere (the DM, a Long Rest)
 * leaves focus on the others.
 */
function HpMaxChips({ character: c, editable, onEdit, pencil }: Omit<VitalsProps, 'onRoll'> & { pencil: RefObject<HTMLButtonElement | null> }) {
  const adjustments = hpMaxAdjustments(c);
  const seen = new Map<string, number>();
  const keys = adjustments.map((a) => {
    // One name is one entry; a hand-edited file can still hold two, so a repeat gets its count.
    const key = `${a.ends}:${a.name}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n ? `${key}#${n}` : key;
  });
  const list = useRef<HTMLUListElement>(null);
  /** The place among the ×s of the one just pressed, until the chips next change. */
  const ended = useRef<number | null>(null);
  useEffect(() => {
    const at = ended.current;
    ended.current = null;
    if (at === null || document.activeElement !== document.body) return;
    const buttons = Array.from(list.current?.querySelectorAll('button') ?? []);
    (buttons[Math.min(at, buttons.length - 1)] ?? pencil.current)?.focus();
  }, [c.hpMaxAdjustments, pencil]);
  if (!adjustments.length) return null;
  return (
    <ul ref={list} className="flex flex-wrap gap-1.5" aria-label="Hit point maximum adjustments">
      {adjustments.map((a, i) => {
        const effect = a.ends !== 'never';
        const tone = !effect ? 'bg-surface-2 text-muted' : a.amount > 0 ? 'bg-arcane-soft text-arcane' : 'bg-danger-soft text-danger';
        const label = `${a.name} ${formatModifier(a.amount)}`;
        return (
          <li key={keys[i]} className={cn('inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 text-xs font-medium', editable && effect ? 'pr-1' : 'pr-2.5', tone)}>
            <span title={ENDS_TITLE[a.ends]}>
              {label}
              <span className="font-normal">, {hpMaxEndsText(a.ends)}</span>
            </span>
            {editable && effect && (
              <button
                type="button"
                aria-label={`End ${a.name} (${formatModifier(a.amount)} hit point maximum)`}
                title={`End ${a.name}`}
                onClick={(e) => {
                  ended.current = Array.from(list.current?.querySelectorAll('button') ?? []).indexOf(e.currentTarget);
                  onEdit((cur) => endHpMaxChange(cur, a.name, a.ends));
                }}
                className={cn('grid size-5 place-items-center rounded-full', a.amount > 0 ? 'hover:bg-arcane/20' : 'hover:bg-danger/20')}
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function HpBlock({ character: c, editable, onEdit }: Omit<VitalsProps, 'onRoll'>) {
  const [amount, setAmount] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
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
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold tracking-wider whitespace-nowrap text-muted uppercase">
          <Heart className="size-3.5 text-danger" aria-hidden /> Hit points
        </span>
        {/* In a narrow rail the badge and pencil wrap below the readout, never the readout itself. */}
        <span className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-1 tabular-nums">
          <span className="text-2xl leading-none font-semibold whitespace-nowrap" aria-label={`${c.hp.current} of ${c.hp.max} hit points`}>
            {c.hp.current}
            <span className="text-base font-normal text-muted"> / {c.hp.max}</span>
          </span>
          {c.hp.temp > 0 && <Badge tone="info">+{c.hp.temp} temp</Badge>}
          {editable && (
            <IconButton ref={pencil} size="sm" label="Adjust hit point maximum" onClick={() => setAdjusting(true)} className="-my-2 self-center">
              <Pencil className="size-3.5" aria-hidden />
            </IconButton>
          )}
        </span>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className={cn('h-full transition-[width]', hpTone(c))} style={{ width: `${(c.hp.current / total) * 100}%` }} />
        {c.hp.temp > 0 && <div className="h-full bg-info" style={{ width: `${(c.hp.temp / total) * 100}%` }} />}
      </div>
      <HpMaxChips character={c} editable={editable} onEdit={onEdit} pencil={pencil} />
      {editable && <HpMaxDialog open={adjusting} character={c} onClose={() => setAdjusting(false)} onEdit={onEdit} />}
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
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-success px-3 text-sm font-medium text-success-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
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

/**
 * What an AC spell does, short on its chip and in full for its × (srd:spell:mage-armor: "the target's base AC becomes
 * 13 plus its Dexterity modifier"; srd:spell:shield-of-faith: "a +2 bonus to AC").
 */
function acSpellWords(name: AcSpellName): { short: string; spoken: string } {
  const { base, bonus = 0 } = AC_SPELLS[name];
  return base !== undefined
    ? { short: `base ${base} + DEX`, spoken: `base Armor Class ${base} plus Dexterity` }
    : { short: formatModifier(bonus), spoken: `${formatModifier(bonus)} Armor Class` };
}

/** Why the AC doesn't count a recorded spell (its formula doesn't name it): a chip's title, under its "not counted". */
function notCountedTitle(c: Character, name: AcSpellName): string {
  const formula = c.acFormula ?? '';
  if (/^set by the DM\b/.test(formula)) return 'Not counted: your AC was set by hand';
  if (AC_SPELLS[name].base === undefined) return 'Not counted in your AC as it stands';
  // A base of its own: armor worn, or another base (Unarmored Defense, Draconic Resilience) as high or higher.
  return /^(?:Unarmored Defense|Draconic Resilience):/.test(formula) ? 'Not counted: another base AC is as high or higher' : 'Not counted while you wear armor';
}

/** The spell chips' ×s (EndSpellButton) under `root`, in the page's order: the panel's focus rule. */
function spellEndButtons(root: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(root?.querySelectorAll<HTMLButtonElement>('button[data-spell-end]') ?? []);
}

const ENDS_WITH: Record<AcSpellName, string> = {
  'Mage Armor': 'Ends at a Long Rest, or when you or your DM end it',
  'Shield of Faith': "Ends with its caster's Concentration, or when you or your DM end it",
};

/**
 * A spell chip's ×: an AC spell's, or the concentration chip's. With `confirm`, the first press asks ("End?", as the
 * inventory's Remove? does) and a second within 3 seconds ends it: the sheet has no control to record an AC spell
 * again, so a stray tap mustn't lose one. `data-spell-end` puts it in the panel's focus rule (VitalsPanel).
 */
function EndSpellButton({
  what,
  title,
  confirm,
  hover,
  onEnd,
}: {
  /** "Mage Armor (base Armor Class 13 plus Dexterity)": the button says "End …", then "Confirm ending …". */
  what: string;
  title: string;
  confirm: boolean;
  hover: string;
  onEnd: (button: HTMLButtonElement) => void;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const id = window.setTimeout(() => setAsking(false), 3000);
    return () => window.clearTimeout(id);
  }, [asking]);
  return (
    <button
      type="button"
      data-spell-end=""
      aria-label={asking ? `Confirm ending ${what}` : `End ${what}`}
      title={asking ? 'Click again to end it' : title}
      onClick={(e) => {
        if (confirm && !asking) setAsking(true);
        else onEnd(e.currentTarget);
      }}
      className={cn(
        'grid h-5 min-w-5 shrink-0 place-items-center rounded-full',
        asking ? 'bg-danger px-1.5 text-[11px] leading-none font-semibold text-danger-ink' : hover,
      )}
    >
      {asking ? 'End?' : <X className="size-3" aria-hidden />}
    </button>
  );
}

/**
 * The AC spells on the hero (Character.acSpells) in a full-width row under the stat tiles: what each does, and whether
 * the AC counts it; Shield of Faith here is another caster's (the one she concentrates on herself is her concentration
 * chip's). An × ends one on a second press; focus then follows the panel's rule (`onEnded`).
 */
function AcSpellChips({
  character: c,
  spells,
  editable,
  onEdit,
  onEnded,
}: Omit<VitalsProps, 'onRoll'> & { spells: readonly AcSpellName[]; onEnded: (button: HTMLButtonElement) => void }) {
  if (!spells.length) return null;
  const counted = countedAcSpells(c);
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Armor Class from spells">
      {spells.map((name) => {
        const on = counted.includes(name);
        const words = acSpellWords(name);
        const base = AC_SPELLS[name].base !== undefined;
        const details = [base ? words.short : "another caster's", ...(on ? [] : ['not counted'])];
        return (
          <li
            key={name}
            className={cn(
              'inline-flex items-center gap-1 rounded-full py-0.5 pl-2.5 text-xs font-medium',
              editable ? 'pr-1' : 'pr-2.5',
              on ? 'bg-arcane-soft text-arcane' : 'bg-surface-2 text-muted',
            )}
          >
            <span title={on ? ENDS_WITH[name] : notCountedTitle(c, name)}>
              {base ? name : `${name} ${words.short}`}
              <span className="font-normal">{details.map((d) => ` · ${d}`).join('')}</span>
            </span>
            {editable && (
              <EndSpellButton
                what={`${name} (${words.spoken})`}
                title={`End ${name}`}
                confirm
                hover={on ? 'hover:bg-arcane/20' : 'hover:bg-surface-3'}
                onEnd={(button) => {
                  onEnded(button);
                  onEdit((cur) => endAcSpellChange(cur, name));
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The hero's vitals. One focus rule for the spell chips' ×s (the AC spells' and the concentration chip's, in the
 * page's order): after one ends its chip, focus goes to the × now in its place, else the one before, else the
 * Inspiration toggle, never to the page. Hero-held Shield of Faith (its record while she concentrates on it) is one
 * chip, the concentration chip's, so it has one way to end.
 */
export function VitalsPanel(props: VitalsProps) {
  const { character: c, editable, onEdit } = props;
  const speed = effectiveSpeed(c);
  const hd = hitDiceText(c);
  const concentration = c.spellcasting?.concentratingOn;
  const recorded = acSpells(c);
  const counted = countedAcSpells(c);
  const held = concentration ? acSpellNamed(concentration) : undefined;
  const folded = held && recorded.includes(held) ? held : undefined;
  const root = useRef<HTMLDivElement>(null);
  const inspiration = useRef<HTMLButtonElement>(null);
  /** The place among the spell ×s of the one just pressed, until the spells next change. */
  const ended = useRef<number | null>(null);
  const onEnded = (button: HTMLButtonElement) => {
    ended.current = spellEndButtons(root.current).indexOf(button);
  };
  useEffect(() => {
    const at = ended.current;
    ended.current = null;
    if (at === null || document.activeElement !== document.body) return;
    const buttons = spellEndButtons(root.current);
    (buttons[Math.min(at, buttons.length - 1)] ?? inspiration.current)?.focus();
  }, [c.acSpells, concentration]);
  const foldedWords = folded ? acSpellWords(folded) : null;
  return (
    <div ref={root} className="flex flex-col gap-3">
      <HpBlock {...props} />
      {c.hp.current === 0 && <DeathSaves {...props} />}
      <div className="grid grid-cols-3 gap-1.5 @lg:grid-cols-6">
        {/* Spells in the AC show on the tile itself, as a changed Speed does, and in the chips below. */}
        <StatTile
          label="AC"
          value={c.armorClass}
          icon={<Shield className="size-3" aria-hidden />}
          title={c.acFormula}
          sub={counted.length ? 'with spells' : undefined}
          border={counted.length ? 'border-arcane/50' : undefined}
        />
        <StatTile label="Init" value={formatModifier(initiativeModifier(c))} icon={<Zap className="size-3" aria-hidden />} title="Initiative" />
        <StatTile
          label="Speed"
          value={speed}
          icon={<Footprints className="size-3" aria-hidden />}
          sub={speed !== c.speed ? `base ${c.speed}` : 'ft.'}
          border={speed < c.speed ? 'border-danger/50' : undefined}
        />
        <StatTile label="Prof" value={formatModifier(proficiencyBonus(characterLevel(c)))} title="Proficiency Bonus" />
        <StatTile label="Passive" value={passivePerception(c)} sub="Perception" title="Passive Perception" />
        <StatTile label="Hit dice" value={hd.value} sub={hd.sub} />
      </div>
      <AcSpellChips character={c} spells={recorded.filter((n) => n !== folded)} editable={editable} onEdit={onEdit} onEnded={onEnded} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          ref={inspiration}
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
          <span className={cn('inline-flex items-center gap-1 rounded-full bg-arcane-soft py-1 pl-2.5 text-xs font-medium text-arcane', editable ? 'pr-1' : 'pr-2.5')}>
            <Brain className="size-3.5" aria-hidden />
            <span title={folded && !counted.includes(folded) ? notCountedTitle(c, folded) : undefined}>
              Concentrating: {concentration}
              {foldedWords && (
                <span className="font-normal">
                  {` · ${foldedWords.short} AC`}
                  {folded && !counted.includes(folded) ? ' · not counted' : ''}
                </span>
              )}
            </span>
            {editable && (
              // While it carries an AC spell, ending it takes a second press: the sheet can't record the spell again.
              <EndSpellButton
                what={`concentration on ${concentration}${foldedWords ? ` (${foldedWords.spoken})` : ''}`}
                title="End concentration"
                confirm={Boolean(folded)}
                hover="hover:bg-arcane/20"
                onEnd={(button) => {
                  onEnded(button);
                  onEdit((cur) => concentrationChange(cur, null));
                }}
              />
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
