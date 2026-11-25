import { useState } from 'react';
import { formatModifier, spellAttackBonus, spellSaveDC } from '@/engine';
import { nameKey } from '@/lib/id';
import { ABILITY_NAMES, type Ability } from '@/types';
import { Badge, Spinner } from '@/ui/components/ui';
import { RulesEntryDialog } from '@/ui/sheet/SpellsPanel';
import { SourceFilter } from '../BookBadges';
import { Issues, RadioCards, StepHeader } from '../BuilderParts';
import {
  classSpellOptions,
  grantedSpells,
  optionBooks,
  picks,
  spellPlan,
  spellsForClass,
  validateStep,
  visibleSpells,
  type MagicInitiateChoice,
  type SpellInfo,
} from '../logic';
import { SpellChoiceList } from '../SpellChoiceList';
import type { StepProps } from './stepTypes';

const MENTAL: Ability[] = ['int', 'wis', 'cha'];

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
  // The source filter narrows what's listed (one spell per name under "All"); spells already chosen stay visible.
  const chosen = new Set([...classIds, ...initiateIds]);
  const visible = (list: SpellInfo[]) => visibleSpells(list, draft.sourceFilter, chosen);
  // Known once chosen in any list, or granted by the class or species, by name: a book's spell and the SRD's
  // of the same name are one spell. Magic Initiate's level 1 spell may be a granted one (it adds a free casting).
  const chosenNames = new Set(ctx.spells.filter((s) => chosen.has(s.id)).map((s) => nameKey(s.name)));
  const named = (keys: ReadonlySet<string>) => new Set(ctx.spells.filter((s) => keys.has(nameKey(s.name))).map((s) => s.id));
  const taken = named(new Set([...chosenNames, ...grantedSpells(draft, ctx.data).keys()]));
  const takenByPicks = named(chosenNames);
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
              taken={taken}
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
                taken={taken}
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
                taken={taken}
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
              taken={taken}
            />
            <SpellChoiceList
              label={`${list} level 1 spell`}
              options={visible(spellsForClass(ctx.spells, list, 1))}
              selected={choice.spell ? [choice.spell] : []}
              max={1}
              onChange={(ids) => update({ spell: ids[0] ?? null })}
              onInfo={setInfo}
              taken={takenByPicks}
            />
          </section>
        );
      })}
      <Issues issues={issues} />
      <RulesEntryDialog spell={info} onClose={() => setInfo(null)} />
    </div>
  );
}
