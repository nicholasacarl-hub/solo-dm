/**
 * The spell picker the builder and the sheet's choices form share: a checklist of spells capped at `max`, with a name
 * filter past 12 options, where a book's or homebrew spell comes from, an "already known" spell shown but not
 * selectable, and an About button. For the sheet it can also name its count in a fieldset legend ("Choose up to 2"),
 * the form's one live status being in its footer, and group a pool of several spell levels by level, the highest open
 * and the others collapsible. A box disabled because the list is full says why; rows and the About button are 44px
 * tall on touch screens. The builder's look is unchanged.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChevronRight, Info } from 'lucide-react';
import { cn } from '@/lib/cn';
import { SRD_SOURCE_ID } from '@/types';
import { Badge, Input } from '@/ui/components/ui';
import { SubHeading } from './BuilderParts';
import { toggleInList, unreviewedImport, type SpellInfo } from './logic';

/** Past this many options a list gets its name filter, and a pool of several levels its level groups. */
const LONG_LIST = 12;

const LIMIT_REACHED = 'Limit reached: uncheck one to change.';

export interface SpellChoiceListProps {
  label: string;
  options: SpellInfo[];
  selected: string[];
  max: number;
  onChange: (next: string[]) => void;
  onInfo: (spell: SpellInfo) => void;
  /** Spells known by name from a choice in any list (shown, but not selectable unless checked here). */
  taken?: Set<string>;
  /**
   * The sheet's form: a fieldset whose legend names the list and its count ("Choose up to 2"), read with the group.
   * Without it the builder's heading shows "n/max".
   */
  countInLegend?: boolean;
  /**
   * A pool of several spell levels: a long one is grouped by level (the highest open, the others collapsible), a short
   * one shows each spell's level.
   */
  byLevel?: boolean;
  /** Under the legend (the sheet's form): a line about the list, such as where its spells come from. */
  note?: ReactNode;
}

function levelName(level: number): string {
  return level === 0 ? 'Cantrips' : `Level ${level}`;
}

export function SpellChoiceList({ label, options, selected, max, onChange, onInfo, taken, countInLegend = false, byLevel = false, note }: SpellChoiceListProps) {
  const [filter, setFilter] = useState('');
  const [openLevels, setOpenLevels] = useState<number[] | null>(null);
  const filterId = useId();
  const limitId = useId();
  const valid = selected.filter((id) => options.some((o) => o.id === id));
  const full = valid.length >= max;
  const query = filter.trim().toLowerCase();
  const shown = query ? options.filter((o) => o.name.toLowerCase().includes(query)) : options;
  const levels = [...new Set(options.map((o) => o.level))].sort((a, b) => b - a);
  const mixed = byLevel && levels.length > 1;
  const grouped = mixed && options.length > LONG_LIST;

  const row = (spell: SpellInfo) => {
    const checked = valid.includes(spell.id);
    const known = !checked && Boolean(taken?.has(spell.id));
    const limited = !checked && !known && full;
    const disabled = known || limited;
    return (
      <li
        key={spell.id}
        className={cn(
          'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors pointer-coarse:min-h-11 pointer-coarse:py-0',
          checked ? 'border-arcane bg-arcane-soft' : 'border-border bg-surface',
          disabled && 'opacity-55',
        )}
      >
        <label className={cn('flex min-w-0 flex-1 items-center gap-2 text-sm', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={() => onChange(toggleInList(valid, spell.id, max))}
            aria-describedby={limited ? limitId : undefined}
            className="size-4 shrink-0 accent-[var(--arcane)]"
          />
          {/* The name keeps its width; the source's label and the school give way first. */}
          <span className="max-w-full shrink-0 truncate font-medium">{spell.name}</span>
          {/* A book's or homebrew spell says where it comes from ("From Homebrew"), so it can't pass for the SRD's. */}
          {spell.entry.sourceId !== SRD_SOURCE_ID && (
            <span className="min-w-0 truncate text-xs text-faint">
              From {spell.entry.sourceName}
              {unreviewedImport(spell) ? ' · not reviewed' : ''}
            </span>
          )}
          {spell.concentration && (
            <Badge tone="arcane" className="px-1.5">
              C
            </Badge>
          )}
          {spell.ritual && <Badge className="px-1.5">R</Badge>}
          {mixed && !grouped && <span className="shrink-0 text-xs text-faint tabular-nums">{levelName(spell.level)}</span>}
          {known ? (
            <span className="truncate text-xs text-faint">already known</span>
          ) : (
            spell.school && <span className="hidden truncate text-xs text-faint capitalize sm:inline">{spell.school}</span>
          )}
        </label>
        <button
          type="button"
          aria-label={`About ${spell.name}`}
          title="Read the spell"
          onClick={() => onInfo(spell)}
          className="grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-surface-2 hover:text-arcane pointer-coarse:size-11"
        >
          <Info className="size-4" aria-hidden />
        </button>
      </li>
    );
  };

  const list = (spells: SpellInfo[], name: string) => (
    <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label={name}>
      {spells.map(row)}
    </ul>
  );

  const isOpen = (level: number) => (openLevels ?? levels.slice(0, 1)).includes(level);
  const setOpen = (level: number, open: boolean) =>
    setOpenLevels((current) => {
      const now = current ?? levels.slice(0, 1);
      return open ? [...new Set([...now, level])] : now.filter((l) => l !== level);
    });

  const body =
    options.length === 0 ? (
      <p className="text-sm text-muted">No spells available for this list.</p>
    ) : !grouped ? (
      list(shown, label)
    ) : query ? (
      // While filtering, every level with a match shows, open.
      <div className="flex flex-col gap-2">
        {levels.map((level) => {
          const matches = shown.filter((s) => s.level === level);
          if (!matches.length) return null;
          return (
            <div key={level} className="flex flex-col gap-1">
              <p className="text-xs font-medium text-muted">{levelName(level)}</p>
              {list(matches, `${label}: ${levelName(level).toLowerCase()}`)}
            </div>
          );
        })}
        {shown.length === 0 && <p className="text-sm text-muted">No spell matches “{filter.trim()}”.</p>}
      </div>
    ) : (
      <div className="flex flex-col gap-1.5">
        {levels.map((level) => {
          const spells = options.filter((s) => s.level === level);
          const chosen = spells.filter((s) => valid.includes(s.id)).length;
          return (
            <details key={level} open={isOpen(level)} onToggle={(e) => setOpen(level, e.currentTarget.open)} className="group rounded-lg">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-1 text-sm font-medium pointer-coarse:min-h-11 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-open:rotate-90" aria-hidden />
                <span>{levelName(level)}</span>{' '}
                <span className="text-xs font-normal text-muted tabular-nums">
                  ({spells.length} {spells.length === 1 ? 'spell' : 'spells'}
                  {chosen ? `, ${chosen} chosen` : ''})
                </span>
              </summary>
              <div className="pt-1">{list(spells, `${label}: ${levelName(level).toLowerCase()}`)}</div>
            </details>
          );
        })}
      </div>
    );

  const controls = (
    <>
      {note}
      {options.length > LONG_LIST && (
        <div>
          <label htmlFor={filterId} className="sr-only">
            Filter {label}
          </label>
          <Input id={filterId} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name…" className="h-9 max-w-xs" />
        </div>
      )}
      {body}
      {/* Why a box is disabled once the list is full; each such box names it (aria-describedby). */}
      {full && (
        <span id={limitId} className="sr-only">
          {LIMIT_REACHED}
        </span>
      )}
    </>
  );

  if (!countInLegend) {
    return (
      <div className="flex flex-col gap-2">
        <SubHeading hint={`${valid.length}/${max}`}>{label}</SubHeading>
        {controls}
      </div>
    );
  }
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 w-full">
        <span className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">{label}</span>{' '}
          <span className="text-xs text-muted tabular-nums">
            Choose up to {max}
            {valid.length ? ` (${valid.length} chosen)` : ''}
          </span>
        </span>
      </legend>
      {controls}
    </fieldset>
  );
}
