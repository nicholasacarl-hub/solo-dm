/**
 * The level-up dialog's one Feat choice panel (spec §5.4, D31): shown when the new level gains Ability
 * Score Improvement, Epic Boon or Fighting Style. "Decide with my DM" is preselected, so a level-up
 * nobody touches here is exactly what it was before; the other choices are +2 to one ability, +1 to
 * two, or a feat from the SRD or the player's books. Only "Level N+" prerequisites are checked, and an
 * unmet one still lets the player go ahead with "My DM allows it".
 */
import { useId, type ReactNode } from 'react';
import { Check, TriangleAlert } from 'lucide-react';
import { ASI_SCORE_MAX, featChoiceComplete, offersScoreIncrease, type FeatChoice, type FeatChoiceTrigger, type FeatPick } from '@/data/options/levelUpChoices';
import { cn } from '@/lib/cn';
import { ABILITIES, ABILITY_NAMES, type Ability, type AbilityScores } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Select } from '@/ui/components/ui';
import { BookBadge } from '@/ui/builder/BookBadges';

const TITLES: Readonly<Record<FeatChoiceTrigger['kind'], string>> = {
  asi: 'Ability Score Improvement or feat',
  'epic-boon': 'Epic Boon or feat',
  'fighting-style': 'Fighting Style',
};

export function featPanelTitle(trigger: FeatChoiceTrigger): string {
  return TITLES[trigger.kind];
}

/**
 * Whether the panel's choice lets the level-up go ahead: an unmet level needs "My DM allows it", and (with
 * the scores) a +2 or +1 +1 needs every chosen ability below 20, so the improvement isn't used up for nothing.
 */
export function featChoiceReady(choice: FeatChoice, dmAllows: boolean, scores?: AbilityScores): boolean {
  if (!featChoiceComplete(choice, scores)) return false;
  return choice.kind !== 'feat' || choice.pick.meetsLevel || dmAllows;
}

/** The abilities in order, those with room for the whole increase first, then those with some room, those at 20 last. */
function roomFirst(scores: AbilityScores, amount = 1): Ability[] {
  const rank = (a: Ability) => (ASI_SCORE_MAX - scores[a] >= amount ? 0 : scores[a] < ASI_SCORE_MAX ? 1 : 2);
  return [...ABILITIES].sort((a, b) => rank(a) - rank(b));
}

function AbilitySelect({
  label,
  value,
  onChange,
  scores,
  only,
  cap,
}: {
  label: string;
  value: Ability | undefined;
  onChange: (a: Ability) => void;
  scores: AbilityScores;
  only?: readonly Ability[];
  /** A score increase by this much (+2 / +1 +1): a score at 20 can't be chosen, and "+1 only" marks a 19 for +2. */
  cap?: { amount: number };
}) {
  const list = only ?? ABILITIES;
  const note = (a: Ability) => {
    if (!cap) return '';
    if (scores[a] >= ASI_SCORE_MAX) return ', the most';
    return ASI_SCORE_MAX - scores[a] < cap.amount ? ', +1 only' : '';
  };
  // The wrapper sets the width: the Select primitive is full-width by design.
  return (
    <div className="w-52 max-w-full shrink-0">
      <Select aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value as Ability)} className="h-8 py-0 text-sm">
        {value === undefined && <option value="">Choose…</option>}
        {list.map((a) => (
          <option key={a} value={a} disabled={Boolean(cap) && scores[a] >= ASI_SCORE_MAX && a !== value}>
            {ABILITY_NAMES[a]} ({scores[a]}{note(a)})
          </option>
        ))}
      </Select>
    </div>
  );
}

function Row({ children, selected, disabled }: { children: ReactNode; selected: boolean; disabled?: boolean }) {
  return (
    <li className={cn('flex flex-col gap-1.5 rounded-xl border px-3 py-2', selected ? 'border-accent bg-accent-soft/50' : 'border-border', disabled && 'opacity-60')}>
      {children}
    </li>
  );
}

/** "Level 4+ ✓", "Level 8+ ✗ needs level 8", and any other prerequisite text for the DM to check. */
function Prerequisite({ pick }: { pick: FeatPick }) {
  const other = (pick.prerequisite ?? '')
    .split(/[,;]\s*/)
    .map((p) => p.trim())
    .filter((p) => p && !/^Level \d+\+$/i.test(p));
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
      {pick.minLevel !== undefined &&
        (pick.meetsLevel ? (
          <span className="inline-flex items-center gap-0.5 text-success">
            Level {pick.minLevel}+ <Check className="size-3.5" aria-hidden />
            <span className="sr-only">met</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-0.5 text-danger">
            Level {pick.minLevel}+ <TriangleAlert className="size-3.5" aria-hidden /> needs level {pick.minLevel}
          </span>
        ))}
      {other.length > 0 && <span>{other.join(', ')} (your DM checks)</span>}
    </span>
  );
}

/** The book a feat comes from, "SRD", or (a style the class prints) the class's book or "Class option". */
function PickSource({ pick }: { pick: FeatPick }) {
  const title = pick.feat ? pick.feat.source?.title : pick.ref?.sourceTitle;
  if (title) return <BookBadge title={title} />;
  return <Badge>{pick.feat ? 'SRD' : 'Class option'}</Badge>;
}

function increaseLabel(pick: FeatPick): string | null {
  const inc = pick.increase;
  if (!inc) return null;
  const names = inc.abilities.length === ABILITIES.length ? 'one ability' : inc.abilities.map((a) => ABILITY_NAMES[a]).join(' or ');
  return `+${inc.amount} ${names}`;
}

/** "Strength is already 20, the most it can reach: choose another ability." · "Strength is 19: it can rise by 1 only." */
function ScoreRoom({ abilities, amount, scores }: { abilities: readonly Ability[]; amount: number; scores: AbilityScores }) {
  const full = abilities.filter((a) => scores[a] >= ASI_SCORE_MAX);
  const short = abilities.filter((a) => scores[a] < ASI_SCORE_MAX && ASI_SCORE_MAX - scores[a] < amount);
  if (full.length) {
    const one = full.length === 1;
    return (
      <p className="text-xs text-danger">
        {full.map((a) => ABILITY_NAMES[a]).join(' and ')} {one ? 'is' : 'are'} already {ASI_SCORE_MAX}, the most {one ? 'it' : 'they'} can reach: choose {one ? 'another ability' : 'other abilities'}.
      </p>
    );
  }
  if (short.length) return <p className="text-xs text-muted">{short.map((a) => `${ABILITY_NAMES[a]} is ${scores[a]}`).join(', ')}: it can rise by {ASI_SCORE_MAX - scores[short[0]]} only.</p>;
  return null;
}

export interface FeatChoicePanelProps {
  trigger: FeatChoiceTrigger;
  picks: readonly FeatPick[];
  choice: FeatChoice;
  onChoice: (choice: FeatChoice) => void;
  scores: AbilityScores;
  dmAllows: boolean;
  onDmAllows: (value: boolean) => void;
}

export function FeatChoicePanel({ trigger, picks, choice, onChoice, scores, dmAllows, onDmAllows }: FeatChoicePanelProps) {
  const name = useId();
  const scoreChoices = offersScoreIncrease(trigger.kind);
  // Defaults that can rise: never a score already at 20 (B3).
  const plusTwo = choice.kind === 'plus-two' ? choice.ability : roomFirst(scores, 2)[0];
  const plusOne: [Ability, Ability] = choice.kind === 'plus-one-one' ? choice.abilities : [roomFirst(scores)[0], roomFirst(scores)[1]];
  const atMost = (a: Ability) => scores[a] >= ASI_SCORE_MAX;
  const selectedPick = choice.kind === 'feat' ? choice.pick : null;
  const radio = (checked: boolean, onSelect: () => void, label: string, disabled = false) => (
    <input type="radio" name={name} checked={checked} onChange={onSelect} disabled={disabled} aria-label={label} className="size-4 shrink-0 accent-[var(--accent)]" />
  );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{featPanelTitle(trigger)}</legend>
      <ul className="flex flex-col gap-1.5">
        <Row selected={choice.kind === 'dm'}>
          <label className="flex items-center gap-2 text-sm">
            {radio(choice.kind === 'dm', () => onChoice({ kind: 'dm' }), 'Decide with my DM')}
            <span>
              <span className="font-medium">Decide with my DM</span>
              <span className="text-muted"> — the sheet notes the choice for your DM</span>
            </span>
          </label>
        </Row>
        {scoreChoices && (
          <Row selected={choice.kind === 'plus-two'}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-2">
                {radio(choice.kind === 'plus-two', () => onChoice({ kind: 'plus-two', ability: plusTwo }), '+2 to one ability')}
                <span className="font-medium">+2 to one ability</span>
              </label>
              <AbilitySelect label="Ability to raise by 2" value={plusTwo} scores={scores} cap={{ amount: 2 }} onChange={(ability) => onChoice({ kind: 'plus-two', ability })} />
            </div>
            {choice.kind === 'plus-two' && <ScoreRoom abilities={[plusTwo]} amount={2} scores={scores} />}
          </Row>
        )}
        {scoreChoices && (
          <Row selected={choice.kind === 'plus-one-one'}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-2">
                {radio(choice.kind === 'plus-one-one', () => onChoice({ kind: 'plus-one-one', abilities: plusOne }), '+1 to two abilities')}
                <span className="font-medium">+1 to two abilities</span>
              </label>
              <AbilitySelect label="First ability to raise by 1" value={plusOne[0]} scores={scores} cap={{ amount: 1 }} onChange={(a) => onChoice({ kind: 'plus-one-one', abilities: [a, plusOne[1]] })} />
              <AbilitySelect label="Second ability to raise by 1" value={plusOne[1]} scores={scores} cap={{ amount: 1 }} onChange={(a) => onChoice({ kind: 'plus-one-one', abilities: [plusOne[0], a] })} />
            </div>
            {choice.kind === 'plus-one-one' && plusOne[0] === plusOne[1] && <p className="text-xs text-danger">Choose two different abilities.</p>}
            {choice.kind === 'plus-one-one' && plusOne[0] !== plusOne[1] && plusOne.some(atMost) && <ScoreRoom abilities={plusOne} amount={1} scores={scores} />}
          </Row>
        )}
        {picks.map((pick) => {
          const selected = selectedPick?.id === pick.id;
          const increase = increaseLabel(pick);
          const ability = selected && choice.kind === 'feat' ? choice.ability : undefined;
          const many = (pick.increase?.abilities.length ?? 0) > 1;
          return (
            <Row key={pick.id} selected={selected} disabled={pick.taken}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <label className="flex items-center gap-2">
                  {radio(selected, () => onChoice({ kind: 'feat', pick, ...(many && pick.increase ? { ability: pick.increase.abilities[0] } : {}) }), pick.name, pick.taken)}
                  <span className="font-medium">{pick.name}</span>
                </label>
                <PickSource pick={pick} />
                <Prerequisite pick={pick} />
                {increase && <span className="text-xs text-muted">· {increase}</span>}
                {many && selected && (
                  <AbilitySelect
                    label={`Ability ${pick.name} raises`}
                    value={ability}
                    scores={scores}
                    only={pick.increase?.abilities}
                    onChange={(a) => onChoice({ kind: 'feat', pick, ability: a })}
                  />
                )}
                {pick.taken && <span className="text-xs text-muted">Already on your sheet</span>}
              </div>
              {pick.description && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer text-faint hover:text-text">What it does</summary>
                  <Markdown className="mt-1 text-sm text-text">{pick.description}</Markdown>
                </details>
              )}
            </Row>
          );
        })}
      </ul>
      {selectedPick && !selectedPick.meetsLevel && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dmAllows} onChange={(e) => onDmAllows(e.target.checked)} className="size-4 accent-[var(--accent)]" />
          My DM allows it
        </label>
      )}
    </fieldset>
  );
}
