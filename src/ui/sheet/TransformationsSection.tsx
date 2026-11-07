/**
 * Transformations: lasting changes the story made to the hero (vampirism, a fey mark, a celestial
 * blessing...). Each active one shows its stage, whether the player accepted it or their choices
 * brought it on, what it means, how it could end, and the features it gave; ended ones fold away.
 */
import { ChevronRight, Dna } from 'lucide-react';
import type { Character, Feature, Transformation } from '@/types';
import { Badge, type BadgeTone } from '@/ui/components/ui';
import { FeatureItem } from './FeatureItem';
import { SheetSection } from './SheetParts';
import type { SheetChange } from './useSheetActions';

type OnEdit = (change: (c: Character) => SheetChange) => void;

const ORIGIN: Record<Transformation['origin'], { label: string; tone: BadgeTone; title: string }> = {
  accepted: { label: 'Accepted', tone: 'neutral', title: 'You chose this' },
  imposed: { label: 'Imposed', tone: 'danger', title: 'A consequence of choices you made' },
};

export function activeTransformations(character: Character): Transformation[] {
  return (character.transformations ?? []).filter((t) => t.status === 'active');
}

/**
 * The features listed under each active transformation: its own (source 'transformation') that are
 * still on the sheet, each under one transformation only. Everything else stays in its usual group.
 */
export function transformationFeatures(character: Character): Map<string, Feature[]> {
  const byId = new Map(character.features.map((f) => [f.id, f]));
  const claimed = new Set<string>();
  const result = new Map<string, Feature[]>();
  for (const t of activeTransformations(character)) {
    const own: Feature[] = [];
    for (const id of t.featureIds) {
      const feature = byId.get(id);
      if (feature?.source !== 'transformation' || claimed.has(id)) continue;
      claimed.add(id);
      own.push(feature);
    }
    result.set(t.id, own);
  }
  return result;
}

function OriginBadge({ origin }: { origin: Transformation['origin'] }) {
  const { label, tone, title } = ORIGIN[origin];
  return (
    <span title={title} className="inline-flex">
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

function TransformationCard({
  transformation: t,
  features,
  editable,
  onEdit,
}: {
  transformation: Transformation;
  features: Feature[];
  editable: boolean;
  onEdit: OnEdit;
}) {
  return (
    <article
      aria-label={`Transformation: ${t.name}`}
      className="rounded-xl border border-l-[3px] border-arcane/40 border-l-arcane bg-surface p-3"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Dna className="size-4 shrink-0 text-arcane" aria-hidden />
        <h4 className="text-sm font-semibold">{t.name}</h4>
        <OriginBadge origin={t.origin} />
      </div>
      {t.stage && <p className="mt-0.5 text-xs font-medium text-arcane">{t.stage}</p>}
      {t.summary && <p className="mt-1.5 text-sm">{t.summary}</p>}
      {t.howItEnds && (
        <p className="mt-1.5 text-xs text-muted">
          <span className="font-semibold text-text">How it could end: </span>
          {t.howItEnds}
        </p>
      )}
      {features.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1.5" aria-label={`Features from ${t.name}`}>
          {features.map((f) => (
            <FeatureItem key={f.id} feature={f} editable={editable} onEdit={onEdit} />
          ))}
        </ul>
      )}
    </article>
  );
}

function EndedTransformations({ ended }: { ended: Transformation[] }) {
  return (
    <details className="group/ended">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium text-muted select-none hover:text-text [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open/ended:rotate-90" aria-hidden />
        Ended ({ended.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5" aria-label="Ended transformations">
        {ended.map((t) => (
          <li key={t.id} className="rounded-xl border border-border bg-surface-2 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-sm font-medium">{t.name}</span>
              <OriginBadge origin={t.origin} />
              {t.endedSession !== undefined && <span className="text-xs text-faint">Ended in session {t.endedSession}</span>}
            </div>
            {t.summary && <p className="mt-0.5 text-xs text-muted">{t.summary}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TransformationsSection({
  character,
  features,
  editable,
  onEdit,
}: {
  character: Character;
  /** From transformationFeatures(character). */
  features: Map<string, Feature[]>;
  editable: boolean;
  onEdit: OnEdit;
}) {
  const all = character.transformations ?? [];
  if (all.length === 0) return null;
  const active = all.filter((t) => t.status === 'active');
  const ended = all.filter((t) => t.status === 'ended');
  return (
    <SheetSection title="Transformations">
      {active.length > 0 ? (
        <div className="flex flex-col gap-2">
          {active.map((t) => (
            <TransformationCard key={t.id} transformation={t} features={features.get(t.id) ?? []} editable={editable} onEdit={onEdit} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No transformation is active right now.</p>
      )}
      {ended.length > 0 && <EndedTransformations ended={ended} />}
    </SheetSection>
  );
}
