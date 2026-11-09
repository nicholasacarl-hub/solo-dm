import { ABILITY_NAMES, SKILL_NAMES } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Card } from '@/ui/components/ui';
import { OlderEditionNotes, OptionSourceBadges, PendingReviewHint, SourceFilter } from '../BookBadges';
import { Detail, Issues, proseSummary, RadioCards, StepHeader, SubHeading } from '../BuilderParts';
import {
  MAGIC_INITIATE_LISTS,
  clashingNames,
  describePackage,
  filtered,
  isMagicInitiate,
  optionBooks,
  originFeatOptions,
  originFeats,
  picks,
  selectBackground,
  validateStep,
} from '../logic';
import type { StepProps } from './stepTypes';

export function BackgroundStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { data } = ctx;
  const { background } = picks(draft, data);
  const feat = originFeats(draft, data).find((f) => f.from === 'background')?.feat;
  const books = optionBooks(data, ctx.spells);
  const clashes = clashingNames(data.backgrounds);
  const featOptions = filtered(originFeatOptions(data), draft.sourceFilter, draft.backgroundFeat);
  const featClashes = clashingNames(originFeatOptions(data));
  const chosenFeat = data.feats.find((f) => f.id === draft.backgroundFeat);
  const issues = validateStep('background', draft, ctx).filter((e) => e.includes('switched off or removed'));
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Choose a background"
        description="Where your hero came from. A background raises three ability scores, grants an Origin feat, two skills, a tool and some starting gear."
        onDmDecide={onDmDecide}
      />
      <SourceFilter books={books} value={draft.sourceFilter} onChange={(sourceFilter) => setDraft((d) => ({ ...d, sourceFilter }))} />
      <Issues issues={issues} />
      <RadioCards
        label="Background"
        collapsible
        value={draft.backgroundId}
        onChange={(id) => setDraft((d) => selectBackground(d, id))}
        options={filtered(data.backgrounds, draft.sourceFilter, draft.backgroundId).map((b) => ({
          value: b.id,
          title: b.name,
          meta: (
            <>
              {b.abilityChoice === 'any' ? <Badge>Any three abilities</Badge> : b.abilityScores.map((a) => <Badge key={a}>{ABILITY_NAMES[a]}</Badge>)}
              <Badge tone="accent">{b.featChoice || !b.feat ? 'Origin feat: your choice' : b.feat}</Badge>
              <OptionSourceBadges option={b} clashes={clashes} />
            </>
          ),
          description: proseSummary(b.summary),
        }))}
      />
      <PendingReviewHint kinds={['background', 'feat']} />
      {background && (
        <Card className="flex flex-col gap-4 p-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Detail label="Ability scores">
              {background.abilityChoice === 'any'
                ? 'Any three abilities you choose (+2/+1 or +1/+1/+1, next step)'
                : `${background.abilityScores.map((a) => ABILITY_NAMES[a]).join(', ')} (+2/+1 or +1/+1/+1, next step)`}
            </Detail>
            <Detail label="Skill proficiencies">{background.skills.map((s) => SKILL_NAMES[s]).join(' and ')}</Detail>
            <Detail label="Tool proficiency">{background.tool || 'None'}</Detail>
            <Detail label="Equipment">
              {background.equipment.map((p) => `${p.label}: ${describePackage(p)}`).join('; or ')}
            </Detail>
            {background.languages?.length ? (
              <Detail label="Languages it lists">{background.languages.join(', ')} — suggested for your two language choices</Detail>
            ) : null}
          </dl>
          <OlderEditionNotes notes={background.source?.adaptations.map((a) => a.note) ?? []} />
          {background.featChoice ? (
            <div className="flex flex-col gap-2">
              <SubHeading>Origin feat: your choice</SubHeading>
              <RadioCards
                label="Origin feat"
                value={draft.backgroundFeat}
                onChange={(id) => setDraft((d) => ({ ...d, backgroundFeat: id, backgroundFeatList: null, magicInitiate: {} }))}
                options={featOptions.map((f) => ({
                  value: f.id,
                  title: f.name,
                  meta: <OptionSourceBadges option={f} clashes={featClashes} />,
                  description: f.description.replace(/\*\*/g, ''),
                }))}
              />
              {chosenFeat && isMagicInitiate(chosenFeat.name) && (
                <div className="flex flex-col gap-2">
                  <SubHeading>Magic Initiate spell list</SubHeading>
                  <RadioCards<string>
                    variant="pills"
                    label="Magic Initiate spell list"
                    value={draft.backgroundFeatList}
                    onChange={(list) => setDraft((d) => ({ ...d, backgroundFeatList: list, magicInitiate: {} }))}
                    options={MAGIC_INITIATE_LISTS.map((l) => ({ value: l, title: l }))}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
              <p className="text-sm font-semibold">Origin feat: {background.feat}</p>
              {feat ? <Markdown className="mt-1 text-sm">{feat.description}</Markdown> : <p className="text-sm text-muted">Details in the Library.</p>}
            </div>
          )}
          {background.legacyFeature && (
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
              <p className="text-sm font-semibold">Background feature: {background.legacyFeature.name}</p>
              <Markdown className="mt-1 text-sm">{background.legacyFeature.description}</Markdown>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
