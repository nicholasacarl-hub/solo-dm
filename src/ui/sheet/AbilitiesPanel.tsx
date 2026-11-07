/**
 * Abilities (score, modifier, saving throw), skills, and proficiencies & senses.
 */
import {
  abilityModifier,
  formatModifier,
  rollRequestModifier,
  savingThrowModifier,
  skillModifier,
} from '@/engine';
import { cn } from '@/lib/cn';
import { ABILITIES, ABILITY_NAMES, SKILLS, SKILL_ABILITY, SKILL_NAMES, type Ability, type Character, type Skill } from '@/types';
import { ProfMarker, RollButton, SheetSection } from './SheetParts';
import type { SheetRoll } from './useSheetActions';

const ABBR: Record<Ability, string> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

function saveRoll(c: Character, ability: Ability): SheetRoll {
  const { modifier, label } = rollRequestModifier(c, { rollType: 'save', ability, revealDc: false, advantage: 'normal', reason: 'Unprompted roll' });
  return { kind: 'd20', modifier, label };
}

function skillRoll(c: Character, skill: Skill): SheetRoll {
  const { modifier, label } = rollRequestModifier(c, { rollType: 'skill', skill, revealDc: false, advantage: 'normal', reason: 'Unprompted roll' });
  return { kind: 'd20', modifier, label };
}

export function AbilitiesGrid({ character: c, onRoll }: { character: Character; onRoll?: (roll: SheetRoll) => void }) {
  return (
    <ul className="grid grid-cols-3 gap-1.5 @xl:grid-cols-6" aria-label="Ability scores">
      {ABILITIES.map((a) => {
        const proficient = c.savingThrows.includes(a);
        const save = savingThrowModifier(c, a);
        return (
          <li key={a} className="flex flex-col items-center rounded-xl border border-border bg-surface-2 px-1 pt-1.5 pb-1 text-center">
            <span className="text-[10px] font-semibold tracking-wider text-muted uppercase" title={ABILITY_NAMES[a]}>
              {ABBR[a]}
            </span>
            <span className="text-xl leading-tight font-semibold tabular-nums" aria-label={`${ABILITY_NAMES[a]} modifier ${formatModifier(abilityModifier(c.abilityScores[a]))}`}>
              {formatModifier(abilityModifier(c.abilityScores[a]))}
            </span>
            <span className="rounded-md bg-surface px-1.5 text-xs text-muted tabular-nums" aria-label={`score ${c.abilityScores[a]}`}>
              {c.abilityScores[a]}
            </span>
            <span className="mt-1 flex w-full items-center justify-center gap-1 border-t border-border pt-0.5 text-[11px] text-muted">
              <ProfMarker level={proficient ? 1 : 0} />
              <span className="tabular-nums">Save {formatModifier(save)}</span>
              {onRoll && <RollButton label={`${ABILITY_NAMES[a]} saving throw`} onRoll={() => onRoll(saveRoll(c, a))} className="-mr-1 size-6" />}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function SkillsList({ character: c, onRoll }: { character: Character; onRoll?: (roll: SheetRoll) => void }) {
  return (
    <ul className="grid grid-cols-1 gap-x-4 @xl:grid-cols-2" aria-label="Skills">
      {SKILLS.map((s) => {
        const level = c.skills[s] ?? 0;
        return (
          <li key={s} className="flex min-h-8 items-center gap-2 border-b border-border/60 py-0.5 text-sm last:border-0">
            <ProfMarker level={level} />
            <span className={cn('min-w-0 flex-1 truncate', level > 0 ? 'text-text' : 'text-muted')}>{SKILL_NAMES[s]}</span>
            <span className="w-8 text-[10px] font-semibold tracking-wider text-faint uppercase">{ABBR[SKILL_ABILITY[s]]}</span>
            <span className="w-8 text-right font-medium tabular-nums">{formatModifier(skillModifier(c, s))}</span>
            {onRoll && <RollButton label={`${SKILL_NAMES[s]} check`} onRoll={() => onRoll(skillRoll(c, s))} />}
          </li>
        );
      })}
    </ul>
  );
}

function Line({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="text-sm">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd>{items.join(', ')}</dd>
    </div>
  );
}

const capitalized = (list: string[] | undefined) => (list ?? []).map((t) => t.charAt(0).toUpperCase() + t.slice(1));

export function ProficienciesList({ character: c }: { character: Character }) {
  const senses = [c.darkvision ? `Darkvision ${c.darkvision} ft.` : null, `Size ${c.size}`].filter((s): s is string => Boolean(s));
  const otherSpeeds = Object.entries(c.otherSpeeds ?? {}).map(([kind, ft]) => `${kind} ${ft} ft.`);
  return (
    <dl className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
      <Line label="Armor training" items={c.armorTraining} />
      <Line label="Weapons" items={c.weaponProficiencies} />
      <Line label="Weapon mastery" items={c.weaponMasteries ?? []} />
      <Line label="Tools" items={c.tools} />
      <Line label="Languages" items={c.languages} />
      <Line label="Senses & size" items={[...senses, ...otherSpeeds]} />
      {/* The engine halves (or ignores, or doubles) damage of these types automatically. */}
      <Line label="Damage resistances" items={capitalized(c.damageResistances)} />
      <Line label="Immunities" items={[...capitalized(c.damageImmunities), ...(c.conditionImmunities ?? [])]} />
      <Line label="Vulnerabilities" items={capitalized(c.damageVulnerabilities)} />
    </dl>
  );
}

export function OverviewPanel({ character, onRoll }: { character: Character; onRoll?: (roll: SheetRoll) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <SheetSection title="Abilities & saves">
        <AbilitiesGrid character={character} onRoll={onRoll} />
      </SheetSection>
      <SheetSection title="Skills">
        <SkillsList character={character} onRoll={onRoll} />
      </SheetSection>
      <SheetSection title="Proficiencies">
        <ProficienciesList character={character} />
      </SheetSection>
    </div>
  );
}
