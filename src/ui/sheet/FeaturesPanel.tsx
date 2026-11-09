/**
 * Features tab: transformations first (they change who the hero is), then class, species, feat and
 * other features with limited-use pips. When features come from the player's books, a dismissible line
 * says their text stays on this device (spec §7.5).
 */
import { useState } from 'react';
import { Info, X } from 'lucide-react';
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

const BOOKS_NOTE_KEY = 'solo-dm:sheet:books-note-dismissed';

function noteDismissed(): boolean {
  try {
    return localStorage.getItem(BOOKS_NOTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** "ⓘ 7 features come from your books. Their text stays on this device; saves keep the names." Shown once per device. */
function BooksNote({ count }: { count: number }) {
  const [hidden, setHidden] = useState(noteDismissed);
  if (hidden || count === 0) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(BOOKS_NOTE_KEY, '1');
    } catch {
      // Private mode: the note just comes back next time.
    }
  };
  return (
    <p className="flex items-start gap-2 rounded-xl border border-info/30 bg-info-soft/60 px-3 py-2 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
      <span className="flex-1">
        {count} {count === 1 ? 'feature comes' : 'features come'} from your books. Their text stays on this device; saves keep the names.
      </span>
      <button type="button" onClick={dismiss} aria-label="Dismiss this note" className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:bg-surface-2 hover:text-text">
        <X className="size-3.5" aria-hidden />
      </button>
    </p>
  );
}

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
  const fromBooks = c.features.filter((f) => f.ref).length;
  return (
    <div className="flex flex-col gap-4">
      <BooksNote count={fromBooks} />
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
