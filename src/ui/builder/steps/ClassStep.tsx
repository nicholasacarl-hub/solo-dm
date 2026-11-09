import { primaryRuleOf } from '@/data/options/resolve';
import { ABILITY_NAMES, SKILL_NAMES, type ClassOption } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Card } from '@/ui/components/ui';
import { OlderEditionNotes, OptionSourceBadges, PendingReviewHint, SourceFilter } from '../BookBadges';
import { Detail, Issues, proseSummary, RadioCards, StepHeader, SubHeading } from '../BuilderParts';
import { classChoiceFeatures, featuresAtLevel, needsFightingStyle } from '../classFeatures';
import { choosesSubclassAtLevel1, clashingNames, fightingStyleChoices, filtered, optionBooks, picks, selectClass, validateStep } from '../logic';
import type { StepProps } from './stepTypes';

const CASTER_LABEL: Record<ClassOption['casterType'], string | null> = {
  full: 'Spellcaster',
  half: 'Half caster',
  third: 'Some spells',
  pact: 'Pact Magic',
  none: null,
};

function list(items: string[]): string {
  return items.length ? items.join(', ') : 'None';
}

function ClassDetails({ cls }: { cls: ClassOption }) {
  const level1 = featuresAtLevel(cls, 1);
  const book = cls.source?.title;
  return (
    <Card className="flex flex-col gap-4 p-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Detail label="Hit Point Die">
          d{cls.hitDie} — {cls.hitDie} + CON modifier at level 1
        </Detail>
        <Detail label="Saving throws">{list(cls.savingThrows.map((a) => ABILITY_NAMES[a]))}</Detail>
        <Detail label="Armor training">{list(cls.armorTraining)}</Detail>
        <Detail label="Weapons">{list(cls.weaponProficiencies)}</Detail>
        <Detail label={`Skills (choose ${cls.skillChoices.count})`}>{list(cls.skillChoices.from.map((s) => SKILL_NAMES[s]))}</Detail>
        {cls.tools.length > 0 && <Detail label="Tools">{list(cls.tools)}</Detail>}
      </dl>
      <OlderEditionNotes notes={cls.source?.adaptations.map((a) => a.note) ?? []} />
      <div className="flex flex-col gap-2">
        <SubHeading hint={book ? `From ${book}` : undefined}>Level 1 features</SubHeading>
        <ul className="flex flex-col gap-1.5">
          {level1.map((f) => (
            <li key={f.name} className="rounded-lg border border-border bg-surface-2">
              <details>
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
                  {f.name}
                  {book && <span className="ml-2 text-xs font-normal text-muted">From {book}</span>}
                </summary>
                <div className="border-t border-border px-3 py-2">
                  <Markdown className="text-sm">{f.description}</Markdown>
                </div>
              </details>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function ClassStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { data } = ctx;
  const { cls } = picks(draft, data);
  const books = optionBooks(data, ctx.spells);
  const classes = filtered(data.classes, draft.sourceFilter, draft.classId);
  const clashes = clashingNames(data.classes);
  const styles = fightingStyleChoices(cls, data, draft.sourceFilter, draft.fightingStyle);
  const styleClashes = clashingNames(styles.map((s) => ({ name: s.name, source: s.feat?.source })));
  const stale = validateStep('class', draft, ctx).filter((e) => e.includes("switched off or removed"));
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Choose a class"
        description="Your class is your hero's calling: it sets your hit points, what you're trained in, and the features you start with."
        onDmDecide={onDmDecide}
      />
      <SourceFilter books={books} value={draft.sourceFilter} onChange={(sourceFilter) => setDraft((d) => ({ ...d, sourceFilter }))} />
      <Issues issues={stale} />
      <RadioCards
        label="Class"
        collapsible
        value={draft.classId}
        onChange={(id) => setDraft((d) => selectClass(d, id))}
        columns="sm:grid-cols-2 xl:grid-cols-3"
        options={classes.map((c) => ({
          value: c.id,
          title: c.name,
          meta: (
            <>
              <Badge>d{c.hitDie}</Badge>
              <Badge>{c.primaryAbilities.map((a) => ABILITY_NAMES[a]).join(primaryRuleOf(c) === 'any' ? ' or ' : ' & ') || 'Any'}</Badge>
              {CASTER_LABEL[c.casterType] && <Badge tone="arcane">{CASTER_LABEL[c.casterType]}</Badge>}
              <OptionSourceBadges option={c} clashes={clashes} />
            </>
          ),
          description: proseSummary(c.summary),
        }))}
      />
      <PendingReviewHint kinds={['class', 'subclass']} />
      {cls && (
        <>
          <ClassDetails cls={cls} />
          {choosesSubclassAtLevel1(cls) && (
            <div className="flex flex-col gap-2">
              <SubHeading>{cls.name} subclass</SubHeading>
              <p className="text-sm text-muted">{cls.name} chooses its subclass at level 1.</p>
              <RadioCards
                label={`${cls.name} subclass`}
                value={draft.subclassId}
                onChange={(subclassId) => setDraft((d) => ({ ...d, subclassId }))}
                options={cls.subclasses.map((s) => ({
                  value: s.id,
                  title: s.name,
                  meta: <OptionSourceBadges option={s} clashes={clashingNames(cls.subclasses)} />,
                  description: s.summary,
                }))}
              />
            </div>
          )}
          {needsFightingStyle(cls) && (
            <div className="flex flex-col gap-2">
              <SubHeading>Fighting Style</SubHeading>
              <RadioCards
                label="Fighting Style"
                value={draft.fightingStyle}
                onChange={(name) => setDraft((d) => ({ ...d, fightingStyle: name }))}
                options={styles.map((f) => ({
                  value: f.name,
                  title: f.name,
                  meta: f.feat ? <OptionSourceBadges option={f.feat} clashes={styleClashes} /> : <Badge>{cls.name} feature</Badge>,
                  description: f.description,
                }))}
              />
            </div>
          )}
          {classChoiceFeatures(cls).map(({ feature, options }) => (
            <div key={feature.name} className="flex flex-col gap-2">
              <SubHeading>{feature.name}</SubHeading>
              <RadioCards
                label={feature.name}
                value={draft.classOptions[feature.name] ?? null}
                onChange={(name) => setDraft((d) => ({ ...d, classOptions: { ...d.classOptions, [feature.name]: name } }))}
                options={options.map((o) => ({ value: o.name, title: o.name, description: o.description }))}
              />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
