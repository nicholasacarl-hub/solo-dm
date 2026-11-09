import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { formatModifier, spellAttackBonus, spellSaveDC } from '@/engine';
import { cn } from '@/lib/cn';
import { ABILITY_NAMES, type Ability } from '@/types';
import { Badge, Input, Spinner } from '@/ui/components/ui';
import { RulesEntryDialog } from '@/ui/sheet/SpellsPanel';
import { SourceFilter } from '../BookBadges';
import { Issues, RadioCards, StepHeader, SubHeading } from '../BuilderParts';
import {
  classSpellOptions,
  optionBooks,
  picks,
  spellInSourceFilter,
  spellPlan,
  spellsForClass,
  toggleInList,
  unreviewedImport,
  validateStep,
  type MagicInitiateChoice,
  type SpellInfo,
} from '../logic';
import type { StepProps } from './stepTypes';

const MENTAL: Ability[] = ['int', 'wis', 'cha'];

function SpellChoiceList({
  label,
  options,
  selected,
  max,
  onChange,
  onInfo,
  taken,
}: {
  label: string;
  options: SpellInfo[];
  selected: string[];
  max: number;
  onChange: (next: string[]) => void;
  onInfo: (spell: SpellInfo) => void;
  /** Spells already known from another source (shown, but not selectable). */
  taken?: Set<string>;
}) {
  const [filter, setFilter] = useState('');
  const filterId = useId();
  const valid = selected.filter((id) => options.some((o) => o.id === id));
  const full = valid.length >= max;
  const shown = filter.trim() ? options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase())) : options;
  return (
    <div className="flex flex-col gap-2">
      <SubHeading hint={`${valid.length}/${max}`}>{label}</SubHeading>
      {options.length > 12 && (
        <div>
          <label htmlFor={filterId} className="sr-only">
            Filter {label}
          </label>
          <Input id={filterId} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name…" className="h-9 max-w-xs" />
        </div>
      )}
      {options.length === 0 ? (
        <p className="text-sm text-muted">No spells available for this list.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label={label}>
          {shown.map((spell) => {
            const checked = valid.includes(spell.id);
            const known = !checked && Boolean(taken?.has(spell.id));
            const disabled = !checked && (full || known);
            return (
              <li
                key={spell.id}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors',
                  checked ? 'border-arcane bg-arcane-soft' : 'border-border bg-surface',
                  disabled && 'opacity-55',
                )}
              >
                <label className={cn('flex min-w-0 flex-1 items-center gap-2 text-sm', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onChange(toggleInList(valid, spell.id, max))}
                    className="size-4 shrink-0 accent-[var(--arcane)]"
                  />
                  <span className="truncate font-medium">{spell.name}</span>
                  {spell.entry.id.startsWith('lib:') && (
                    <span className="truncate text-xs text-faint">
                      From {spell.entry.sourceName}
                      {unreviewedImport(spell) ? ' · not reviewed' : ''}
                    </span>
                  )}
                  {spell.concentration && (
                    <Badge tone="arcane" className="px-1.5">
                      C
                    </Badge>
                  )}
                  {spell.ritual && <Badge className="px-1.5">R</Badge>}
                  {known ? (
                    <span className="truncate text-xs text-faint">already known</span>
                  ) : (
                    spell.school && <span className="hidden truncate text-xs text-faint capitalize sm:inline">{spell.school}</span>
                  )}
                </label>
                <button
                  type="button"
                  aria-label={`About ${spell.name}`}
                  title="Read the spell"
                  onClick={() => onInfo(spell)}
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-arcane"
                >
                  <Info className="size-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SpellsStep({ draft, setDraft, ctx, onDmDecide, built, spellsLoading, spellsError }: StepProps & { spellsLoading: boolean; spellsError: string | null }) {
  const [info, setInfo] = useState<SpellInfo | null>(null);
  const { cls } = picks(draft, ctx.data);
  const plan = spellPlan(draft, ctx.data);
  const issues = validateStep('spells', draft, ctx);
  const ability = built?.spellcasting?.ability;
  const dc = built && ability ? spellSaveDC(built, ability) : null;
  const attack = built && ability ? spellAttackBonus(built, ability) : null;

  const header = (
    <StepHeader
      title="Spells"
      description="Choose the cantrips you know and the level 1 spells you have prepared. You can change prepared spells after a Long Rest."
      onDmDecide={onDmDecide}
    />
  );
  if (spellsLoading) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner label="Loading spells" /> Loading the spell lists…
        </div>
      </div>
    );
  }
  if (!ctx.spells.length) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-muted">
          The spell lists aren't available right now{spellsError ? ` (${spellsError})` : ''}. Carry on — the DM can help you pick spells in your first session.
        </p>
      </div>
    );
  }

  const initiateIdsOf = (list: string): string[] => {
    const choice = draft.magicInitiate[list];
    return [...(choice?.cantrips ?? []), ...(choice?.spell ? [choice.spell] : [])];
  };
  const initiateIds = new Set(plan.magicInitiate.flatMap((m) => initiateIdsOf(m.list)));
  const classIds = [...draft.cantrips, ...draft.spellbook, ...draft.prepared];
  const takenFor = (list: string) => new Set([...classIds, ...plan.magicInitiate.filter((m) => m.list !== list).flatMap((m) => initiateIdsOf(m.list))]);
  // The source filter narrows what's listed; spells already chosen stay visible.
  const chosen = new Set([...classIds, ...initiateIds]);
  const visible = (list: SpellInfo[]) => list.filter((sp) => spellInSourceFilter(sp, draft.sourceFilter) || chosen.has(sp.id));
  const cantripOptions = visible(classSpellOptions(draft, ctx, 0));
  const levelOneOptions = visible(classSpellOptions(draft, ctx, 1));
  const spellbookSpells = classSpellOptions(draft, ctx, 1).filter((s) => draft.spellbook.includes(s.id));

  return (
    <div className="flex flex-col gap-6">
      {header}
      <SourceFilter books={optionBooks(ctx.data, ctx.spells)} value={draft.sourceFilter} onChange={(sourceFilter) => setDraft((d) => ({ ...d, sourceFilter }))} label="Show spells from" />
      {ability && (
        <div className="flex flex-wrap gap-2 text-sm">
          <Badge tone="arcane">Spellcasting: {ABILITY_NAMES[ability]}</Badge>
          {dc !== null && <Badge tone="arcane">Save DC {dc}</Badge>}
          {attack !== null && <Badge tone="arcane">Spell attack {formatModifier(attack)}</Badge>}
        </div>
      )}
      {plan.casting && cls && (
        <>
          {plan.cantrips > 0 && (
            <SpellChoiceList
              label={`${cls.name} cantrips`}
              options={cantripOptions}
              selected={draft.cantrips}
              max={plan.cantrips}
              onChange={(cantrips) => setDraft((d) => ({ ...d, cantrips }))}
              onInfo={setInfo}
              taken={initiateIds}
            />
          )}
          {plan.spellbook > 0 ? (
            <>
              <SpellChoiceList
                label="Spellbook (level 1 spells)"
                options={levelOneOptions}
                selected={draft.spellbook}
                max={plan.spellbook}
                onChange={(spellbook) => setDraft((d) => ({ ...d, spellbook, prepared: d.prepared.filter((id) => spellbook.includes(id)) }))}
                onInfo={setInfo}
                taken={initiateIds}
              />
              <SpellChoiceList
                label="Prepared from your spellbook"
                options={spellbookSpells}
                selected={draft.prepared}
                max={plan.prepared}
                onChange={(prepared) => setDraft((d) => ({ ...d, prepared }))}
                onInfo={setInfo}
              />
            </>
          ) : (
            plan.prepared > 0 && (
              <SpellChoiceList
                label="Prepared level 1 spells"
                options={levelOneOptions}
                selected={draft.prepared}
                max={plan.prepared}
                onChange={(prepared) => setDraft((d) => ({ ...d, prepared }))}
                onInfo={setInfo}
                taken={initiateIds}
              />
            )
          )}
        </>
      )}
      {plan.magicInitiate.map(({ list, source }) => {
        const choice: MagicInitiateChoice = draft.magicInitiate[list] ?? { ability: null, cantrips: [], spell: null };
        const update = (patch: Partial<MagicInitiateChoice>) =>
          setDraft((d) => {
            const current: MagicInitiateChoice = d.magicInitiate[list] ?? { ability: null, cantrips: [], spell: null };
            return { ...d, magicInitiate: { ...d.magicInitiate, [list]: { ...current, ...patch } } };
          });
        return (
          <section key={list} className="flex flex-col gap-3 rounded-xl border border-arcane/40 p-4" aria-label={`Magic Initiate (${list})`}>
            <div>
              <h3 className="font-display font-semibold">Magic Initiate ({list})</h3>
              <p className="text-xs text-muted">From {source}: two cantrips and one level 1 spell you can cast once per Long Rest without a slot.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Spellcasting ability for these spells</span>
              <RadioCards<Ability>
                variant="pills"
                label={`Magic Initiate (${list}) spellcasting ability`}
                value={choice.ability}
                onChange={(a) => update({ ability: a })}
                options={MENTAL.map((a) => ({ value: a, title: ABILITY_NAMES[a] }))}
              />
            </div>
            <SpellChoiceList
              label={`${list} cantrips`}
              options={visible(spellsForClass(ctx.spells, list, 0))}
              selected={choice.cantrips}
              max={2}
              onChange={(cantrips) => update({ cantrips })}
              onInfo={setInfo}
              taken={takenFor(list)}
            />
            <SpellChoiceList
              label={`${list} level 1 spell`}
              options={visible(spellsForClass(ctx.spells, list, 1))}
              selected={choice.spell ? [choice.spell] : []}
              max={1}
              onChange={(ids) => update({ spell: ids[0] ?? null })}
              onInfo={setInfo}
              taken={takenFor(list)}
            />
          </section>
        );
      })}
      <Issues issues={issues} />
      <RulesEntryDialog spell={info} onClose={() => setInfo(null)} />
    </div>
  );
}
