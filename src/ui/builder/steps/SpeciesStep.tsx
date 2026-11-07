import { ABILITY_NAMES, SKILL_NAMES, type Ability, type CreatureSize, type Skill } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Card } from '@/ui/components/ui';
import { Issues, proseSummary, RadioCards, StepHeader, SubHeading, ToggleChip } from '../BuilderParts';
import {
  MAGIC_INITIATE_LISTS,
  grantedSkills,
  isMagicInitiate,
  originFeatOptions,
  originFeats,
  picks,
  selectSpecies,
  skillPlan,
  validateSpeciesSkill,
} from '../logic';
import type { StepProps } from './stepTypes';

const MENTAL: Ability[] = ['int', 'wis', 'cha'];

export function SpeciesStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { data } = ctx;
  const p = picks(draft, data);
  const { species, choices } = p;
  const plan = skillPlan(draft, data);
  const granted = grantedSkills(plan);
  const backgroundFeat = originFeats(draft, data).find((f) => f.from === 'background');
  const featOptions = originFeatOptions(data).filter((f) => f.repeatable || f.id !== backgroundFeat?.feat?.id);
  const chosenFeat = data.feats.find((f) => f.id === draft.speciesFeat);
  const skillIssues = validateSpeciesSkill(draft, data).filter((e) => e.includes('already'));
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Choose a species"
        description="Your species sets your size and speed and gives you special traits — darkvision, resistances, innate magic and more."
        onDmDecide={onDmDecide}
      />
      <RadioCards
        label="Species"
        value={draft.speciesId}
        onChange={(id) => setDraft((d) => selectSpecies(d, id))}
        columns="sm:grid-cols-2 xl:grid-cols-3"
        options={data.species.map((s) => ({
          value: s.id,
          title: s.name,
          meta: (
            <>
              <Badge>{s.sizes.join(' or ')}</Badge>
              <Badge>{s.speed} ft.</Badge>
              {s.darkvision ? <Badge>Darkvision {s.darkvision} ft.</Badge> : null}
            </>
          ),
          description: proseSummary(s.summary),
        }))}
      />
      {species && (
        <>
          <Card className="flex flex-col gap-2 p-4">
            <SubHeading>{species.name} traits</SubHeading>
            <ul className="flex flex-col gap-1.5">
              {species.traits.map((t) => (
                <li key={t.name} className="rounded-lg border border-border bg-surface-2">
                  <details>
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t.name}</summary>
                    <div className="border-t border-border px-3 py-2">
                      <Markdown className="text-sm">{t.description}</Markdown>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </Card>

          {choices.lineages.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>{choices.lineageTrait?.name ?? `Choose a ${choices.lineageNoun}`}</SubHeading>
              <RadioCards
                label={choices.lineageTrait?.name ?? choices.lineageNoun}
                value={draft.lineage}
                onChange={(name) => setDraft((d) => ({ ...d, lineage: name }))}
                columns="sm:grid-cols-2 xl:grid-cols-3"
                options={choices.lineages.map((l) => ({ value: l.name, title: l.name, description: l.description }))}
              />
            </div>
          )}

          {choices.lineageNeedsAbility && (
            <div className="flex flex-col gap-2">
              <SubHeading>Spellcasting ability for {choices.lineageNoun} spells</SubHeading>
              <RadioCards<Ability>
                variant="pills"
                label={`Spellcasting ability for ${choices.lineageNoun} spells`}
                value={draft.lineageAbility}
                onChange={(a) => setDraft((d) => ({ ...d, lineageAbility: a }))}
                options={MENTAL.map((a) => ({ value: a, title: ABILITY_NAMES[a] }))}
              />
            </div>
          )}

          {choices.sizes.length > 1 && (
            <div className="flex flex-col gap-2">
              <SubHeading>Size</SubHeading>
              <RadioCards<CreatureSize>
                variant="pills"
                label="Size"
                value={draft.size}
                onChange={(size) => setDraft((d) => ({ ...d, size }))}
                options={choices.sizes.map((s) => ({ value: s, title: s }))}
              />
            </div>
          )}

          {plan.speciesChoice && (
            <div className="flex flex-col gap-2">
              <SubHeading hint="Choose 1">{plan.speciesChoice.trait}: skill proficiency</SubHeading>
              <div className="flex flex-wrap gap-1.5">
                {plan.speciesChoice.from.map((s: Skill) => {
                  const taken = granted.has(s);
                  return (
                    <ToggleChip
                      key={s}
                      pressed={draft.speciesSkill === s}
                      disabled={taken && draft.speciesSkill !== s}
                      reason={taken ? 'From your background' : undefined}
                      onToggle={() => setDraft((d) => ({ ...d, speciesSkill: d.speciesSkill === s ? null : s }))}
                    >
                      {SKILL_NAMES[s]}
                    </ToggleChip>
                  );
                })}
              </div>
              <Issues issues={skillIssues} />
            </div>
          )}

          {choices.originFeat && (
            <div className="flex flex-col gap-2">
              <SubHeading>{choices.originFeat.trait}: an Origin feat of your choice</SubHeading>
              <RadioCards
                label="Origin feat"
                value={draft.speciesFeat}
                onChange={(id) => setDraft((d) => ({ ...d, speciesFeat: id, speciesFeatList: null, featSkills: [] }))}
                options={featOptions.map((f) => ({ value: f.id, title: f.name, description: f.description.replace(/\*\*/g, '') }))}
              />
              {chosenFeat && isMagicInitiate(chosenFeat.name) && (
                <div className="flex flex-col gap-2">
                  <SubHeading>Magic Initiate spell list</SubHeading>
                  <RadioCards<string>
                    variant="pills"
                    label="Magic Initiate spell list"
                    value={draft.speciesFeatList}
                    onChange={(list) => setDraft((d) => ({ ...d, speciesFeatList: list }))}
                    options={MAGIC_INITIATE_LISTS.filter((l) => l !== backgroundFeat?.option).map((l) => ({ value: l, title: l }))}
                  />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
