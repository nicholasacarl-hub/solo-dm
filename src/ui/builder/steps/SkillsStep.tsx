import { Lock } from 'lucide-react';
import { SKILLS, SKILL_NAMES, type Skill } from '@/types';
import { Issues, StepHeader, SubHeading, ToggleChip } from '../BuilderParts';
import {
  RARE_LANGUAGES,
  STANDARD_LANGUAGES,
  classSkillOptions,
  grantedSkills,
  languagePlan,
  picks,
  skillPlan,
  skillProficiencies,
  toggleInList,
  validateLanguages,
  validateSkills,
} from '../logic';
import type { StepProps } from './stepTypes';

function Locked({ children, source }: { children: string; source: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-sm" title={source}>
      <Lock className="size-3 text-faint" aria-hidden />
      {children}
      <span className="text-xs text-faint">· {source}</span>
    </span>
  );
}

export function SkillsStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { data } = ctx;
  const { cls, background, species } = picks(draft, data);
  const plan = skillPlan(draft, data);
  const granted = grantedSkills(plan);
  const { options, replacements } = classSkillOptions(draft, plan);
  const conflicts = draft.classSkills.filter((s) => granted.has(s) || s === draft.speciesSkill);
  const outsideList = draft.classSkills.filter((s) => !plan.classChoice.from.includes(s)).length;
  const replacementPool = replacements > 0 ? SKILLS.filter((s) => !plan.classChoice.from.includes(s) && !granted.has(s) && s !== draft.speciesSkill) : [];
  const beforeFeat = new Set<Skill>([...granted, ...(draft.speciesSkill ? [draft.speciesSkill] : []), ...draft.classSkills]);
  const proficient = Object.keys(skillProficiencies({ ...draft, expertise: [] }, data)) as Skill[];
  const langs = languagePlan(draft, data);
  const languageCount = langs.standard + langs.any;
  const chosenLanguages = draft.languages.filter((l) => !langs.fixed.includes(l));
  const rareChosen = chosenLanguages.filter((l) => !(STANDARD_LANGUAGES as readonly string[]).includes(l)).length;
  const issues = [...validateSkills(draft, data), ...validateLanguages(draft, data)].filter(
    (e) => !/^Choose \d+ (class skills|skills for|languages)/.test(e),
  );

  const classFull = draft.classSkills.length >= plan.classChoice.count;
  const featFull = draft.featSkills.length >= plan.featChoice;
  const expertiseFull = draft.expertise.length >= plan.expertise;
  const languagesFull = chosenLanguages.length >= languageCount;
  const FULL = 'Unselect one first';

  const toggleClassSkill = (s: Skill) =>
    setDraft((d) => ({ ...d, classSkills: toggleInList(d.classSkills, s, plan.classChoice.count), expertise: d.expertise.filter((x) => x !== s) }));

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Skills & languages"
        description="Your background's skills are set; choose the rest from your class list. You also know Common and two more languages."
        onDmDecide={onDmDecide}
      />

      {(plan.background.length > 0 || plan.species.length > 0 || draft.speciesSkill) && (
        <div className="flex flex-col gap-2">
          <SubHeading>Already proficient</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {plan.background.map((s) => (
              <Locked key={s} source={background?.name ?? 'Background'}>
                {SKILL_NAMES[s]}
              </Locked>
            ))}
            {[...plan.species, ...(draft.speciesSkill ? [draft.speciesSkill] : [])].map((s) => (
              <Locked key={s} source={species?.name ?? 'Species'}>
                {SKILL_NAMES[s]}
              </Locked>
            ))}
          </div>
        </div>
      )}

      {cls && (
        <div className="flex flex-col gap-2">
          <SubHeading hint={`${draft.classSkills.length}/${plan.classChoice.count}`}>{cls.name} skills</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {plan.classChoice.from.map((s) => {
              const taken = granted.has(s) || s === draft.speciesSkill;
              const chosen = draft.classSkills.includes(s);
              return (
                <ToggleChip
                  key={s}
                  pressed={chosen}
                  tone={chosen && taken ? 'danger' : 'accent'}
                  disabled={!chosen && (taken || classFull)}
                  reason={taken ? 'You already have this from your origin' : !chosen && classFull ? FULL : undefined}
                  onToggle={() => toggleClassSkill(s)}
                >
                  {SKILL_NAMES[s]}
                </ToggleChip>
              );
            })}
          </div>
          {conflicts.length > 0 && (
            <p className="text-sm text-danger">
              {conflicts.map((s) => SKILL_NAMES[s]).join(', ')} {conflicts.length > 1 ? 'are' : 'is'} already granted by your origin — tap to remove and pick a replacement.
            </p>
          )}
          {replacements > 0 && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface-2 p-3">
              <p className="text-sm">
                Your origin already covers part of the {cls.name} list, so you may pick {replacements} replacement {replacements > 1 ? 'skills' : 'skill'} from
                any skill ({outsideList}/{replacements}).
              </p>
              <div className="flex flex-wrap gap-1.5">
                {replacementPool.map((s) => (
                  <ToggleChip
                    key={s}
                    pressed={draft.classSkills.includes(s)}
                    disabled={!draft.classSkills.includes(s) && classFull}
                    reason={!draft.classSkills.includes(s) && classFull ? FULL : undefined}
                    onToggle={() => toggleClassSkill(s)}
                  >
                    {SKILL_NAMES[s]}
                  </ToggleChip>
                ))}
              </div>
            </div>
          )}
          {options.length === 0 && replacements === 0 && <p className="text-sm text-muted">Nothing left to choose.</p>}
        </div>
      )}

      {plan.featChoice > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading hint={`${draft.featSkills.length}/${plan.featChoice}`}>Skilled feat</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {SKILLS.filter((s) => !beforeFeat.has(s) || draft.featSkills.includes(s)).map((s) => (
              <ToggleChip
                key={s}
                pressed={draft.featSkills.includes(s)}
                tone={beforeFeat.has(s) ? 'danger' : 'accent'}
                disabled={!draft.featSkills.includes(s) && featFull}
                reason={!draft.featSkills.includes(s) && featFull ? FULL : undefined}
                onToggle={() => setDraft((d) => ({ ...d, featSkills: toggleInList(d.featSkills, s, plan.featChoice) }))}
              >
                {SKILL_NAMES[s]}
              </ToggleChip>
            ))}
          </div>
        </div>
      )}

      {plan.expertise > 0 && (
        <div className="flex flex-col gap-2">
          <SubHeading hint={`${draft.expertise.length}/${plan.expertise}`}>Expertise (double proficiency)</SubHeading>
          <div className="flex flex-wrap gap-1.5">
            {proficient.map((s) => (
              <ToggleChip
                key={s}
                tone="arcane"
                pressed={draft.expertise.includes(s)}
                disabled={!draft.expertise.includes(s) && expertiseFull}
                reason={!draft.expertise.includes(s) && expertiseFull ? FULL : undefined}
                onToggle={() => setDraft((d) => ({ ...d, expertise: toggleInList(d.expertise, s, plan.expertise) }))}
              >
                {SKILL_NAMES[s]}
              </ToggleChip>
            ))}
            {proficient.length === 0 && <p className="text-sm text-muted">Choose your skills first.</p>}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <SubHeading hint={`${chosenLanguages.length}/${languageCount}`}>Languages</SubHeading>
        <div className="flex flex-wrap gap-1.5">
          {langs.fixed.map((l) => (
            <Locked key={l} source={l === 'Common' ? 'Everyone' : (cls?.name ?? 'Class')}>
              {l}
            </Locked>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Standard languages">
          {STANDARD_LANGUAGES.filter((l) => !langs.fixed.includes(l)).map((l) => (
            <ToggleChip
              key={l}
              pressed={draft.languages.includes(l)}
              disabled={!draft.languages.includes(l) && languagesFull}
              reason={!draft.languages.includes(l) && languagesFull ? FULL : undefined}
              onToggle={() => setDraft((d) => ({ ...d, languages: toggleInList(d.languages, l, languageCount) }))}
            >
              {l}
            </ToggleChip>
          ))}
        </div>
        {langs.any > 0 && (
          <>
            <p className="text-xs text-muted">Your class lets you pick {langs.any} more from any table, including these rare languages:</p>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Rare languages">
              {RARE_LANGUAGES.filter((l) => !langs.fixed.includes(l)).map((l) => (
                <ToggleChip
                  key={l}
                  tone="arcane"
                  pressed={draft.languages.includes(l)}
                  disabled={!draft.languages.includes(l) && (rareChosen >= langs.any || languagesFull)}
                  onToggle={() => setDraft((d) => ({ ...d, languages: toggleInList(d.languages, l, languageCount) }))}
                >
                  {l}
                </ToggleChip>
              ))}
            </div>
          </>
        )}
      </div>
      <Issues issues={issues} />
    </div>
  );
}
