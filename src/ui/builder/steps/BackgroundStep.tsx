import { ABILITY_NAMES, SKILL_NAMES } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, Card } from '@/ui/components/ui';
import { Detail, proseSummary, RadioCards, StepHeader } from '../BuilderParts';
import { describePackage, findFeat, picks, selectBackground } from '../logic';
import type { StepProps } from './stepTypes';

export function BackgroundStep({ draft, setDraft, ctx, onDmDecide }: StepProps) {
  const { data } = ctx;
  const { background } = picks(draft, data);
  const feat = background ? findFeat(data.feats, background.feat) : undefined;
  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="Choose a background"
        description="Where your hero came from. A background raises three ability scores, grants an Origin feat, two skills, a tool and some starting gear."
        onDmDecide={onDmDecide}
      />
      <RadioCards
        label="Background"
        value={draft.backgroundId}
        onChange={(id) => setDraft((d) => selectBackground(d, id))}
        options={data.backgrounds.map((b) => ({
          value: b.id,
          title: b.name,
          meta: (
            <>
              {b.abilityScores.map((a) => (
                <Badge key={a}>{ABILITY_NAMES[a]}</Badge>
              ))}
              <Badge tone="accent">{b.feat}</Badge>
            </>
          ),
          description: proseSummary(b.summary),
        }))}
      />
      {background && (
        <Card className="flex flex-col gap-4 p-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Detail label="Ability scores">{background.abilityScores.map((a) => ABILITY_NAMES[a]).join(', ')} (+2/+1 or +1/+1/+1, next step)</Detail>
            <Detail label="Skill proficiencies">{background.skills.map((s) => SKILL_NAMES[s]).join(' and ')}</Detail>
            <Detail label="Tool proficiency">{background.tool}</Detail>
            <Detail label="Equipment">
              {background.equipment.map((p) => `${p.label}: ${describePackage(p)}`).join('; or ')}
            </Detail>
          </dl>
          <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
            <p className="text-sm font-semibold">
              Origin feat: {background.feat}
            </p>
            {feat ? <Markdown className="mt-1 text-sm">{feat.description}</Markdown> : <p className="text-sm text-muted">Details in the Library.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
