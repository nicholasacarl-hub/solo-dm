/**
 * Features tab: class, species, feat and other features with limited-use pips.
 */
import { useId, useState } from 'react';
import { ChevronDown, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Character, Feature, FeatureSource } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge, EmptyState } from '@/ui/components/ui';
import { featureUseChange } from './sheetChanges';
import { Pips, SheetSection } from './SheetParts';
import type { SheetChange } from './useSheetActions';

const GROUPS: { title: string; sources: FeatureSource[] }[] = [
  { title: 'Class features', sources: ['class', 'subclass'] },
  { title: 'Species traits', sources: ['species'] },
  { title: 'Feats & background', sources: ['feat', 'background'] },
  { title: 'Boons, items & homebrew', sources: ['boon', 'item', 'homebrew', 'other'] },
];

const RECHARGE: Record<NonNullable<Feature['uses']>['recharge'], string> = {
  short: 'Short or Long Rest',
  long: 'Long Rest',
  dawn: 'Dawn',
  turn: 'Each turn',
  none: 'No recharge',
};

/** Pips up to 10 uses; a −/+ counter for big pools such as Lay on Hands. */
const MAX_PIPS = 10;

function UsesControl({ feature, editable, onEdit }: { feature: Feature; editable: boolean; onEdit: (change: (c: Character) => SheetChange) => void }) {
  const uses = feature.uses!;
  const left = uses.max - uses.used;
  const toggle = editable ? (fill: boolean) => onEdit((c) => featureUseChange(c, feature.id, !fill)) : undefined;
  if (uses.max <= MAX_PIPS) {
    return <Pips total={uses.max} filled={left} tone="accent" label={`${feature.name} uses`} onToggle={toggle} />;
  }
  return (
    <div className="flex items-center gap-1" role="group" aria-label={`${feature.name}: ${left} of ${uses.max} left`}>
      {toggle && (
        <button type="button" aria-label={`Use 1 ${feature.name}`} onClick={() => toggle(false)} className="grid size-7 place-items-center rounded-lg border border-border hover:bg-surface-2">
          <Minus className="size-3.5" aria-hidden />
        </button>
      )}
      <span className="min-w-14 text-center text-sm font-semibold tabular-nums">
        {left}/{uses.max}
      </span>
      {toggle && (
        <button type="button" aria-label={`Restore 1 ${feature.name}`} onClick={() => toggle(true)} className="grid size-7 place-items-center rounded-lg border border-border hover:bg-surface-2">
          <Plus className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

function FeatureItem({ feature, editable, onEdit }: { feature: Feature; editable: boolean; onEdit: (change: (c: Character) => SheetChange) => void }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <li className="rounded-xl border border-border bg-surface-2">
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
        >
          <ChevronDown className={cn('mt-0.5 size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} aria-hidden />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{feature.name}</span>
            {feature.sourceName && <span className="block text-xs text-faint">{feature.sourceName}</span>}
          </span>
        </button>
        {feature.homebrewId && <Badge tone="arcane">Homebrew</Badge>}
        {feature.uses && (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <UsesControl feature={feature} editable={editable} onEdit={onEdit} />
            <span className="text-[10px] text-faint">{RECHARGE[feature.uses.recharge]}</span>
          </div>
        )}
      </div>
      {open && (
        <div id={bodyId} className="border-t border-border px-3 py-2">
          {feature.description ? <Markdown className="text-sm">{feature.description}</Markdown> : <p className="text-sm text-muted">No description.</p>}
        </div>
      )}
    </li>
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
  if (!c.features.length) return <EmptyState title="No features yet">Class features, species traits and feats appear here.</EmptyState>;
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(({ title, sources }) => {
        const features = c.features.filter((f) => sources.includes(f.source));
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
