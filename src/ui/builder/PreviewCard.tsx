/**
 * Live preview of the hero being built: the derived level 1 numbers from the engine.
 */
import { Heart, Shield, Sparkles, Swords } from 'lucide-react';
import { formatModifier } from '@/engine';
import { cn } from '@/lib/cn';
import { ABILITY_NAMES, SKILL_NAMES, type Ability, type Character } from '@/types';
import { Card } from '@/ui/components/ui';
import { Portrait, classSummary } from '@/ui/sheet/SheetHeader';
import { StatTile } from '@/ui/sheet/SheetParts';
import type { PreviewStats } from './logic';

const ABBR: Record<Ability, string> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

export function PreviewCard({ built, stats, className }: { built: Character | null; stats: PreviewStats | null; className?: string }) {
  if (!built || !stats || built.classes.length === 0) {
    return (
      <Card className={cn('flex flex-col items-center gap-2 p-5 text-center', className)}>
        <Portrait portrait={built?.portrait} size="lg" />
        <p className="font-display font-semibold">Your hero takes shape here</p>
        <p className="text-sm text-muted">Choose a class to see hit points, armor class and more update as you build.</p>
      </Card>
    );
  }
  const proficientSkills = stats.skills.filter((s) => s.level > 0).sort((a, b) => b.modifier - a.modifier);
  const subtitle = [built.species, built.background, classSummary(built)].filter(Boolean).join(' · ');
  return (
    <Card role="region" className={cn('@container flex flex-col gap-4 p-4', className)} aria-label="Character preview">
      <div className="flex items-center gap-3">
        <Portrait portrait={built.portrait} />
        <div className="min-w-0">
          <p className="truncate font-display text-lg leading-tight font-semibold">{built.name || 'Unnamed hero'}</p>
          <p className="line-clamp-2 text-xs text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <StatTile label="HP" value={stats.hp} icon={<Heart className="size-3 text-danger" aria-hidden />} />
        <StatTile label="AC" value={stats.ac} icon={<Shield className="size-3" aria-hidden />} title={stats.acFormula} />
        <StatTile label="Init" value={formatModifier(stats.initiative)} />
        <StatTile label="Speed" value={stats.speed} sub="ft." />
        <StatTile label="Prof" value={formatModifier(stats.proficiencyBonus)} />
        <StatTile label="Passive" value={stats.passivePerception} sub="Perception" />
      </div>
      <ul className="grid grid-cols-6 gap-1" aria-label="Ability scores">
        {stats.abilities.map((a) => (
          <li
            key={a.ability}
            className={cn('flex flex-col items-center rounded-lg border px-0.5 py-1', a.saveProficient ? 'border-accent/60 bg-accent-soft/40' : 'border-border bg-surface-2')}
            title={`${ABILITY_NAMES[a.ability]} ${a.score} (save ${formatModifier(a.save)}${a.saveProficient ? ', proficient' : ''})`}
          >
            <span className="text-[10px] font-semibold tracking-wider text-muted">{ABBR[a.ability]}</span>
            <span className="text-sm font-semibold tabular-nums">{formatModifier(a.modifier)}</span>
            <span className="text-[10px] text-faint tabular-nums">{a.score}</span>
            <span className="sr-only">
              {ABILITY_NAMES[a.ability]} {a.score}, saving throw {formatModifier(a.save)}
              {a.saveProficient ? ' (proficient)' : ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 text-sm">
        <p>
          <span className="text-xs font-medium text-muted">Saving throws </span>
          {stats.abilities
            .filter((a) => a.saveProficient)
            .map((a) => `${ABILITY_NAMES[a.ability]} ${formatModifier(a.save)}`)
            .join(', ') || '—'}
        </p>
        <p>
          <span className="text-xs font-medium text-muted">Skills </span>
          {proficientSkills.length
            ? proficientSkills.map((s) => `${SKILL_NAMES[s.skill]} ${formatModifier(s.modifier)}${s.level === 2 ? ' (expertise)' : ''}`).join(', ')
            : '—'}
        </p>
      </div>
      {stats.spell && (
        <p className="flex items-center gap-1.5 text-sm text-arcane">
          <Sparkles className="size-4" aria-hidden />
          Spell save DC <span className="font-semibold tabular-nums">{stats.spell.saveDc}</span> · attack{' '}
          <span className="font-semibold tabular-nums">{formatModifier(stats.spell.attackBonus)}</span>
        </p>
      )}
      {stats.attacks.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Attacks">
          {stats.attacks.slice(0, 5).map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <Swords className="size-3.5 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <span className="font-semibold tabular-nums">{formatModifier(a.bonus)}</span>
              <span className="text-right text-muted tabular-nums" title={`${a.damage} ${a.damageType}`}>
                {a.damage}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
