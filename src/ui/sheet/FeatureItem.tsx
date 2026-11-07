/**
 * One feature on the sheet: name, source, limited-use pips, and its rules text on demand.
 * Features a transformation gave the hero carry the arcane accent.
 */
import { useId, useState } from 'react';
import { ChevronDown, Dna, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Character, Feature } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Badge } from '@/ui/components/ui';
import { featureUseChange } from './sheetChanges';
import { Pips } from './SheetParts';
import type { SheetChange } from './useSheetActions';

const RECHARGE: Record<NonNullable<Feature['uses']>['recharge'], string> = {
  short: 'Short or Long Rest',
  long: 'Long Rest',
  dawn: 'Dawn',
  turn: 'Each turn',
  none: 'No recharge',
};

/** Pips up to 10 uses; a −/+ counter for big pools such as Lay on Hands. */
const MAX_PIPS = 10;

type OnEdit = (change: (c: Character) => SheetChange) => void;

function UsesControl({ feature, editable, onEdit }: { feature: Feature; editable: boolean; onEdit: OnEdit }) {
  const uses = feature.uses!;
  const left = uses.max - uses.used;
  const toggle = editable ? (fill: boolean) => onEdit((c) => featureUseChange(c, feature.id, !fill)) : undefined;
  const tone = feature.source === 'transformation' ? 'arcane' : 'accent';
  if (uses.max <= MAX_PIPS) {
    return <Pips total={uses.max} filled={left} tone={tone} label={`${feature.name} uses`} onToggle={toggle} />;
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

export function FeatureItem({ feature, editable, onEdit }: { feature: Feature; editable: boolean; onEdit: OnEdit }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const transformation = feature.source === 'transformation';
  return (
    <li
      data-source={feature.source}
      className={cn('rounded-xl border', transformation ? 'border-arcane/40 bg-arcane-soft/40' : 'border-border bg-surface-2')}
    >
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
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {transformation && <Dna className="size-3.5 shrink-0 text-arcane" aria-hidden />}
              {feature.name}
            </span>
            {feature.sourceName && <span className={cn('block text-xs', transformation ? 'text-arcane' : 'text-faint')}>{feature.sourceName}</span>}
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
        <div id={bodyId} className={cn('border-t px-3 py-2', transformation ? 'border-arcane/25' : 'border-border')}>
          {feature.description ? <Markdown className="text-sm">{feature.description}</Markdown> : <p className="text-sm text-muted">No description.</p>}
        </div>
      )}
    </li>
  );
}
