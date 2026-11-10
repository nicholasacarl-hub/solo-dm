/**
 * One feature on the sheet: name, source, limited-use pips, and its rules text on demand.
 * Features a transformation gave the hero carry the arcane accent. A feature from one of the player's
 * books carries a book badge; on a device without that book (a save or GitHub copy leaves the text
 * out) its body says so, with Open the Library and Look again (spec §7.5).
 */
import { useId, useState, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router';
import { ChevronDown, Dna, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { copiedTextMissing } from '@/lib/importedContent';
import { useGame } from '@/state/gameStore';
import type { Character, Feature } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { toast } from '@/ui/components/toast';
import { Badge, Button } from '@/ui/components/ui';
import { BookBadge } from '@/ui/builder/BookBadges';
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

/**
 * The book text was left out of this copy (an export, a GitHub save) and this device hasn't filled it back in.
 * Text written there since (the DM's ruling over a pulled placeholder) shows as written, even where a character
 * stored before that was fixed still carries a stale `ref.redacted`.
 */
export function textMissing(feature: Pick<Feature, 'description' | 'ref'>): boolean {
  return copiedTextMissing(feature);
}

/** A link to the Library: the router's when there is one (the app), else the hash URL. */
function LibraryLink({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext();
  const className = 'inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2';
  return inRouter ? (
    <Link to="/library" className={className}>
      {children}
    </Link>
  ) : (
    <a href="#/library" className={className}>
      {children}
    </a>
  );
}

/** "This text is from …, which isn't in this device's Library." with Open the Library and Look again. */
function MissingText({ title }: { title: string }) {
  const restore = useGame((s) => s.restoreImportedText);
  const [busy, setBusy] = useState(false);
  const lookAgain = async () => {
    setBusy(true);
    try {
      const report = await restore?.();
      if (report && report.restored > 0) toast.success(`Filled in ${report.restored} ${report.restored === 1 ? 'passage' : 'passages'} from your Library.`);
      else toast.info(`“${title}” still isn't in this device's Library.`);
    } catch {
      toast.error("Couldn't read your Library just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        This text is from “{title}”, which isn't in this device's Library. Import the book here and it comes back.
      </p>
      <div className="flex flex-wrap gap-2">
        <LibraryLink>Open the Library</LibraryLink>
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void lookAgain()}>
          Look again
        </Button>
      </div>
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
            {/* Under the name, so narrow panels keep the name on one line. */}
            {feature.ref && (
              <span className="mt-0.5 flex">
                <BookBadge title={feature.ref.sourceTitle} />
              </span>
            )}
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
          {feature.ref && textMissing(feature) ? (
            <MissingText title={feature.ref.sourceTitle} />
          ) : feature.description ? (
            <Markdown className="text-sm">{feature.description}</Markdown>
          ) : (
            <p className="text-sm text-muted">No description.</p>
          )}
        </div>
      )}
    </li>
  );
}
