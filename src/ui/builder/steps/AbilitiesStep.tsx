import { Dices, Minus, Plus, Sparkles } from 'lucide-react';
import { abilityModifier, formatModifier, rollDice } from '@/engine';
import { cn } from '@/lib/cn';
import { ABILITIES, ABILITY_NAMES, type Ability } from '@/types';
import { Button, Select } from '@/ui/components/ui';
import { RadioCards, StepHeader, SubHeading, ToggleChip } from '../BuilderParts';
import {
  POINT_BUY_BUDGET,
  adjustPointBuy,
  assignScore,
  backgroundAbilityPool,
  backgroundBonuses,
  baseScores,
  canAdjustPointBuy,
  cappedAbilities,
  picks,
  pointBuyCost,
  pointBuyRemaining,
  recommendedAssignment,
  rollAbilityScores,
  scorePool,
  type AbilityMethod,
  type BonusMode,
} from '../logic';
import type { StepProps } from './stepTypes';

const ABBR: Record<Ability, string> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

function RolledSets({ draft }: Pick<StepProps, 'draft'>) {
  if (!draft.rolls?.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Rolled scores">
      {draft.rolls.map((r, i) => (
        <li key={i} className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-2.5 py-1.5">
          <span className="text-lg font-semibold tabular-nums">{r.total}</span>
          <span className="flex gap-1 text-xs text-muted tabular-nums" aria-label={`dice ${r.dice.join(', ')}, dropped ${r.dice[r.droppedIndex]}`}>
            {r.dice.map((d, j) => (
              <span key={j} className={cn(j === r.droppedIndex && 'text-faint line-through')}>
                {d}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AbilitiesStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { cls, background } = picks(draft, ctx.data);
  const pool = scorePool(draft);
  const base = baseScores(draft).scores;
  const bonuses = backgroundBonuses(draft, background);
  const capped = cappedAbilities(draft, background);
  const remaining = pointBuyRemaining(draft.pointBuy);

  const setMethod = (abilityMethod: AbilityMethod) => setDraft((d) => ({ ...d, abilityMethod, assignment: abilityMethod === d.abilityMethod ? d.assignment : {} }));
  const roll = () => setDraft((d) => ({ ...d, rolls: rollAbilityScores((e) => rollDice(e)), assignment: {} }));
  const recommend = () => setDraft((d) => ({ ...d, assignment: recommendedAssignment(cls, scorePool(d)) }));
  const setBonusMode = (bonusMode: BonusMode) => setDraft((d) => ({ ...d, bonusMode }));
  const bonusPool = backgroundAbilityPool(background);
  const anyThree = background?.abilityChoice === 'any';
  const toggleAnyThree = (a: Ability) =>
    setDraft((d) => {
      const has = d.backgroundAbilities.includes(a);
      if (has) return { ...d, backgroundAbilities: d.backgroundAbilities.filter((x) => x !== a) };
      return d.backgroundAbilities.length >= 3 ? d : { ...d, backgroundAbilities: [...d.backgroundAbilities, a] };
    });

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Ability scores"
        description="Generate six scores, assign them, then apply your background's increases. Put your best scores in your class's primary abilities."
        onDmDecide={onDmDecide}
      />
      <div className="flex flex-col gap-2">
        <SubHeading>Method</SubHeading>
        <RadioCards<AbilityMethod>
          variant="pills"
          label="Ability score method"
          value={draft.abilityMethod}
          onChange={setMethod}
          options={[
            { value: 'standard', title: 'Standard array' },
            { value: 'point-buy', title: 'Point buy' },
            { value: 'roll', title: 'Roll 4d6' },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {draft.abilityMethod === 'standard' && <span>Assign 15, 14, 13, 12, 10 and 8 — one each.</span>}
          {draft.abilityMethod === 'point-buy' && (
            <span>
              Spend {POINT_BUY_BUDGET} points on scores from 8 to 15.{' '}
              <span className={cn('font-semibold tabular-nums', remaining === 0 ? 'text-success' : 'text-text')}>{remaining} left</span>
            </span>
          )}
          {draft.abilityMethod === 'roll' && <span>Roll four d6 and keep the highest three — six times — then assign them.</span>}
          {draft.abilityMethod !== 'point-buy' && cls && pool.length === 6 && (
            <Button size="sm" variant="ghost" icon={<Sparkles className="size-4 text-arcane" aria-hidden />} onClick={recommend}>
              Recommended for {cls.name}
            </Button>
          )}
        </div>
        {draft.abilityMethod === 'roll' && (
          <div className="flex flex-col gap-2">
            <Button variant="secondary" size="sm" icon={<Dices className="size-4" aria-hidden />} onClick={roll} className="self-start">
              {draft.rolls?.length ? 'Roll again' : 'Roll 4d6, drop the lowest — six times'}
            </Button>
            <RolledSets draft={draft} />
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Ability scores</caption>
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-1.5 font-medium">Ability</th>
              <th scope="col" className="py-1.5 font-medium">Score</th>
              <th scope="col" className="py-1.5 text-center font-medium">Bonus</th>
              <th scope="col" className="py-1.5 text-center font-medium">Total</th>
              <th scope="col" className="py-1.5 text-center font-medium">Mod</th>
            </tr>
          </thead>
          <tbody>
            {ABILITIES.map((a) => {
              const bonus = bonuses[a] ?? 0;
              const total = Math.min(20, base[a] + bonus);
              const assigned = draft.assignment[a];
              const primary = cls?.primaryAbilities.includes(a);
              return (
                <tr key={a} className="border-t border-border">
                  <th scope="row" className="py-2 pr-2 text-left font-medium">
                    <span className="flex items-center gap-1.5">
                      <span className="w-8 text-xs font-semibold tracking-wider text-muted">{ABBR[a]}</span>
                      <span className="hidden sm:inline">{ABILITY_NAMES[a]}</span>
                      {primary && (
                        <>
                          <span aria-hidden className="size-1.5 rounded-full bg-accent" title="Primary ability" />
                          <span className="sr-only">(primary ability)</span>
                        </>
                      )}
                    </span>
                  </th>
                  <td className="py-2 pr-2">
                    {draft.abilityMethod === 'point-buy' ? (
                      <div className="flex items-center gap-1" role="group" aria-label={`${ABILITY_NAMES[a]} score`}>
                        <button
                          type="button"
                          aria-label={`Lower ${ABILITY_NAMES[a]}`}
                          disabled={!canAdjustPointBuy(draft.pointBuy, a, -1)}
                          onClick={() => setDraft((d) => ({ ...d, pointBuy: adjustPointBuy(d.pointBuy, a, -1) }))}
                          className="grid size-8 place-items-center rounded-lg border border-border hover:bg-surface-2 disabled:opacity-40"
                        >
                          <Minus className="size-3.5" aria-hidden />
                        </button>
                        <span className="w-7 text-center text-base font-semibold tabular-nums">{draft.pointBuy[a]}</span>
                        <button
                          type="button"
                          aria-label={`Raise ${ABILITY_NAMES[a]}`}
                          disabled={!canAdjustPointBuy(draft.pointBuy, a, 1)}
                          onClick={() => setDraft((d) => ({ ...d, pointBuy: adjustPointBuy(d.pointBuy, a, 1) }))}
                          className="grid size-8 place-items-center rounded-lg border border-border hover:bg-surface-2 disabled:opacity-40"
                        >
                          <Plus className="size-3.5" aria-hidden />
                        </button>
                        <span className="ml-1 hidden text-xs text-faint tabular-nums sm:inline">{pointBuyCost(draft.pointBuy[a])} pt</span>
                      </div>
                    ) : (
                      <Select
                        aria-label={`${ABILITY_NAMES[a]} score`}
                        value={assigned === undefined ? '' : String(assigned)}
                        disabled={pool.length === 0}
                        onChange={(e) => setDraft((d) => ({ ...d, assignment: assignScore(d.assignment, a, e.target.value === '' ? null : Number(e.target.value)) }))}
                        className="h-9 w-24 tabular-nums"
                      >
                        <option value="">—</option>
                        {pool.map((value, i) => {
                          const holder = ABILITIES.find((x) => draft.assignment[x] === i);
                          return (
                            <option key={i} value={i}>
                              {value}
                              {holder && holder !== a ? ` (${ABBR[holder]})` : ''}
                            </option>
                          );
                        })}
                      </Select>
                    )}
                  </td>
                  <td className="py-2 text-center tabular-nums">{bonus ? <span className="font-semibold text-success">+{bonus}</span> : <span className="text-faint">—</span>}</td>
                  <td className="py-2 text-center text-base font-semibold tabular-nums">{assigned === undefined && draft.abilityMethod !== 'point-buy' ? '—' : total}</td>
                  <td className="py-2 text-center tabular-nums text-muted">{assigned === undefined && draft.abilityMethod !== 'point-buy' ? '' : formatModifier(abilityModifier(total))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {background ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <SubHeading>{background.name} ability increases</SubHeading>
          {anyThree && <p className="text-sm text-muted">{background.name} lists no abilities: you choose which to increase.</p>}
          <RadioCards<BonusMode>
            variant="pills"
            label="Increase pattern"
            value={draft.bonusMode}
            onChange={setBonusMode}
            options={[
              { value: 'two-one', title: '+2 and +1' },
              { value: 'one-one-one', title: '+1 to all three' },
            ]}
          />
          {draft.bonusMode === 'two-one' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">+2 to</span>
                <RadioCards<Ability>
                  variant="pills"
                  label="Ability that gets +2"
                  value={draft.bonusPlus2}
                  onChange={(a) => setDraft((d) => ({ ...d, bonusPlus2: a, bonusPlus1: d.bonusPlus1 === a ? null : d.bonusPlus1 }))}
                  options={bonusPool.map((a) => ({ value: a, title: ABILITY_NAMES[a] }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">+1 to</span>
                <RadioCards<Ability>
                  variant="pills"
                  label="Ability that gets +1"
                  value={draft.bonusPlus1}
                  onChange={(a) => setDraft((d) => ({ ...d, bonusPlus1: a }))}
                  options={bonusPool.map((a) => ({ value: a, title: ABILITY_NAMES[a], disabled: a === draft.bonusPlus2 }))}
                />
              </div>
            </div>
          )}
          {draft.bonusMode === 'one-one-one' && anyThree && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">+1 to three abilities ({draft.backgroundAbilities.length}/3)</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Abilities that get +1">
                {bonusPool.map((a) => {
                  const on = draft.backgroundAbilities.includes(a);
                  const full = !on && draft.backgroundAbilities.length >= 3;
                  return (
                    <ToggleChip key={a} pressed={on} disabled={full} reason={full ? 'Unselect one first' : undefined} onToggle={() => toggleAnyThree(a)}>
                      {ABILITY_NAMES[a]}
                    </ToggleChip>
                  );
                })}
              </div>
            </div>
          )}
          {capped.length > 0 && (
            <p className="text-xs text-gold">Scores can't go above 20 — part of the increase to {capped.map((a) => ABILITY_NAMES[a]).join(', ')} is lost.</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Choose a background to apply its ability score increases.</p>
      )}
    </div>
  );
}
