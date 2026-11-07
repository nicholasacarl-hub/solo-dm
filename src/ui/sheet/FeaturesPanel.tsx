/**
 * Features tab: transformations first (they change who the hero is), then class, species, feat and
 * other features with limited-use pips.
 */
import type { Character, FeatureSource } from '@/types';
import { EmptyState } from '@/ui/components/ui';
import { FeatureItem } from './FeatureItem';
import { SheetSection } from './SheetParts';
import { TransformationsSection, transformationFeatures } from './TransformationsSection';
import type { SheetChange } from './useSheetActions';

const GROUPS: { title: string; sources: FeatureSource[] }[] = [
  { title: 'Class features', sources: ['class', 'subclass'] },
  { title: 'Species traits', sources: ['species'] },
  { title: 'Feats & background', sources: ['feat', 'background'] },
  { title: 'Boons, items & homebrew', sources: ['boon', 'item', 'homebrew', 'other'] },
  // Features a transformation left without its record (the cards above list the rest).
  { title: 'Transformation features', sources: ['transformation'] },
];

export function FeaturesPanel({
  character: c,
  editable,
  onEdit,
}: {
  character: Character;
  editable: boolean;
  onEdit: (change: (c: Character) => SheetChange) => void;
}) {
  if (!c.features.length && !c.transformations?.length) {
    return <EmptyState title="No features yet">Class features, species traits and feats appear here.</EmptyState>;
  }
  const nested = transformationFeatures(c);
  const shownWithTransformation = new Set([...nested.values()].flat().map((f) => f.id));
  return (
    <div className="flex flex-col gap-4">
      <TransformationsSection character={c} features={nested} editable={editable} onEdit={onEdit} />
      {GROUPS.map(({ title, sources }) => {
        const features = c.features.filter((f) => sources.includes(f.source) && !shownWithTransformation.has(f.id));
        if (!features.length) return null;
        return (
          <SheetSection key={title} title={title}>
            <ul className="flex flex-col gap-1.5">
              {features.map((f) => (
                <FeatureItem key={f.id} feature={f} editable={editable} onEdit={onEdit} />
              ))}
            </ul>
          </SheetSection>
        );
      })}
    </div>
  );
}
