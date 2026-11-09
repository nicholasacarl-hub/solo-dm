/**
 * Pieces of the record detail (spec §4.4–§4.7): the notices above the form (warnings with "Go to field"
 * and "Show", run states, older-edition notes), the spoiler guard for monsters and magic items, the
 * stats-line preview ("What the app and the DM will use") and the proposal diff (Now / New).
 */
import { useMemo, type ReactNode } from 'react';
import { create } from 'zustand';
import { CircleX, Eye, History, Info, ShieldAlert, TriangleAlert } from 'lucide-react';
import { materializeEntries, statsLine } from '@/data';
import { cn } from '@/lib/cn';
import type { CompendiumEntry, LibrarySource, RecordWarning, StructuredDataByKind, StructuredKind, StructuredRecord } from '@/types';
import { Button } from '@/ui/components/ui';
import { dataPathsFor } from './forms/fieldMap';
import { labelForPath } from './forms/formSpecs';
import { bySeverity } from './warnings';

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

const ICONS = { block: CircleX, warn: TriangleAlert, info: Info } as const;
const TONES = {
  block: 'border-danger/40 bg-danger-soft/60 text-text',
  warn: 'border-gold/40 bg-gold-soft/60 text-text',
  info: 'border-border bg-surface-2 text-muted',
} as const;
const ICON_TONES = { block: 'text-danger', warn: 'text-gold', info: 'text-info' } as const;

export function Notice({ tone, icon, children, actions }: { tone: 'block' | 'warn' | 'info'; icon?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const Icon = ICONS[tone];
  return (
    <div className={cn('flex flex-wrap items-start gap-x-2.5 gap-y-1.5 rounded-xl border px-3 py-2 text-sm', TONES[tone])}>
      <span className={cn('mt-0.5 shrink-0', ICON_TONES[tone])}>{icon ?? <Icon className="size-4" aria-hidden />}</span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}

const SEVERITY_WORD = { block: 'Problem', warn: 'Check', info: 'Note' } as const;
const RUN_CODES = new Set<RecordWarning['code']>(['needs-claude', 'newer-version', 'stale-text', 'failed', 'refused']);

/** The record's warnings, problems first, with a way to the field they name. */
export function DetailNotices({
  kind,
  warnings,
  modelNote,
  onGoToField,
  onShowExcerpt,
}: {
  kind: StructuredKind;
  warnings: readonly RecordWarning[];
  modelNote?: string;
  onGoToField(path: string): void;
  onShowExcerpt(path: string): void;
}) {
  // Run states (not read, failed, declined, stale, newer version) have their own notices with actions.
  const shown = [...warnings].filter((w) => !RUN_CODES.has(w.code)).sort(bySeverity);
  if (shown.length === 0 && !modelNote) return null;
  return (
    <section aria-label="Things to check" className="flex flex-col gap-2">
      {shown.map((w, i) => {
        const path = dataPathsFor(kind, w.field)[0];
        return (
          <Notice
            key={`${w.code}-${w.field ?? ''}-${i}`}
            tone={w.severity}
            actions={
              path && path !== 'kind' ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => onGoToField(path)}>
                    Go to field<span className="sr-only">: {labelForPath(kind, path)}</span>
                  </Button>
                  {w.code === 'ungrounded' && (
                    <Button size="sm" variant="ghost" onClick={() => onShowExcerpt(path)}>
                      Show<span className="sr-only"> the text for {labelForPath(kind, path)}</span>
                    </Button>
                  )}
                </>
              ) : undefined
            }
          >
            <span className="sr-only">{SEVERITY_WORD[w.severity]}: </span>
            {w.message}
          </Notice>
        );
      })}
      {modelNote && (
        <Notice tone="info">
          <span className="font-medium">Claude's note:</span> {modelNote}
        </Notice>
      )}
    </section>
  );
}

export function AdaptationNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <Notice tone="warn" icon={<History className="size-4" aria-hidden />}>
      <p className="font-medium">Older edition</p>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </Notice>
  );
}

// ---------------------------------------------------------------------------
// Spoiler guard (D24)
// ---------------------------------------------------------------------------

const spoilerKey = (sourceId: string) => `solo-dm:show-stats:${sourceId}`;

function readShown(sourceId: string): boolean {
  try {
    return window.sessionStorage.getItem(spoilerKey(sourceId)) === '1';
  } catch {
    return false;
  }
}

function rememberShown(sourceId: string): void {
  try {
    window.sessionStorage.setItem(spoilerKey(sourceId), '1');
  } catch {
    // Private mode or blocked storage: the choice lasts until the page closes.
  }
}

export const isGuarded = (kind: StructuredKind): boolean => kind === 'monster' || kind === 'magic-item';

/** Books whose stats the player chose to see, shared by every guard on the page (fields and source text). */
const useShownBooks = create<{ shown: Readonly<Record<string, true>>; show(sourceId: string): void }>()((set) => ({
  shown: {},
  show: (sourceId) => set((s) => ({ shown: { ...s.shown, [sourceId]: true } })),
}));

/** Monsters and magic items start behind "Show details" (remembered for this book in this tab). */
export function SpoilerGuard({ kind, sourceId, children }: { kind: StructuredKind; sourceId: string; children: ReactNode }) {
  const shownHere = useShownBooks((s) => s.shown[sourceId] === true);
  const show = useShownBooks((s) => s.show);
  const shown = !isGuarded(kind) || shownHere || readShown(sourceId);
  if (shown) return <>{children}</>;
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-surface-2/50 px-6 py-8 text-center">
      <ShieldAlert className="size-6 text-muted" aria-hidden />
      <p className="max-w-sm text-sm text-muted">
        Stats can spoil surprises. You can accept confident {kind === 'monster' ? 'monsters' : 'magic items'} without opening them.
      </p>
      <Button
        icon={<Eye className="size-4" aria-hidden />}
        onClick={() => {
          rememberShown(sourceId);
          show(sourceId);
        }}
      >
        Show details
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats preview (D23): the stats line of the entry this record would become
// ---------------------------------------------------------------------------

/** statsLine() of the materialized entry for a record with these fields ('' when it can't be built yet). */
export function previewLine(
  record: StructuredRecord,
  data: StructuredDataByKind[StructuredKind],
  entriesById: ReadonlyMap<string, CompendiumEntry>,
  source: LibrarySource,
): string {
  try {
    const entries = record.entryIds.flatMap((id) => {
      const e = entriesById.get(id);
      return e ? [e] : [];
    });
    const asAccepted: StructuredRecord = { ...record, data, status: 'accepted' };
    const entry = materializeEntries(entries, [asAccepted], [{ ...source, enabled: true }]).find((e) => e.data?.recordId === record.id);
    return entry ? statsLine(entry).replace(/^Reviewed stats:\s*/, '') : '';
  } catch {
    return '';
  }
}

export function StatsPreview({ line }: { line: string }) {
  if (!line) return null;
  return (
    <section aria-labelledby="stats-preview-title" className="rounded-xl border border-border bg-surface-2/60 px-3 py-2.5">
      <h3 id="stats-preview-title" className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">
        What the app and the DM will use
      </h3>
      <p className="mt-1 text-sm whitespace-pre-line [overflow-wrap:anywhere]">{line}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Proposal diff (D17)
// ---------------------------------------------------------------------------

type Leaf = string;

function flatten(value: unknown, prefix: string, out: Map<string, Leaf>): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object') {
    out.set(prefix, String(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      out.set(prefix, value.join(', '));
      return;
    }
    value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
    return;
  }
  const keys = Object.keys(value as object);
  if ('entryIds' in (value as object) && 'from' in (value as object)) {
    const s = value as { from: number; to: number };
    out.set(prefix, s.from === s.to ? `¶${s.from}` : `¶${s.from}–${s.to}`);
    return;
  }
  for (const k of keys) flatten((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
}

/** The fields that differ between two versions of the data (dotted paths, display strings). */
export function diffData(now: unknown, next: unknown): { path: string; now: string; next: string }[] {
  const a = new Map<string, Leaf>();
  const b = new Map<string, Leaf>();
  flatten(now, '', a);
  flatten(next, '', b);
  const paths = [...new Set([...a.keys(), ...b.keys()])];
  return paths.filter((p) => a.get(p) !== b.get(p)).map((p) => ({ path: p, now: a.get(p) ?? '—', next: b.get(p) ?? '—' }));
}

export function ProposalDiff({ record, onUse, onKeep, busy }: { record: StructuredRecord; onUse(): void; onKeep(): void; busy?: boolean }) {
  const rows = useMemo(() => (record.proposal ? diffData(record.data, record.proposal.data) : []), [record]);
  if (!record.proposal) return null;
  return (
    <section aria-labelledby="proposal-title" className="rounded-xl border border-info/40 bg-info-soft/50 p-3">
      <h3 id="proposal-title" className="text-sm font-medium">
        A newer reading is waiting
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        {record.status === 'accepted' ? 'This entry is in use with your fields. ' : 'You edited this entry. '}
        {rows.length === 0 ? 'The new reading has the same fields.' : `It differs in ${rows.length} ${rows.length === 1 ? 'field' : 'fields'}:`}
      </p>
      {rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Field
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Now
                </th>
                <th scope="col" className="py-1 font-medium">
                  New
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map((r) => (
                <tr key={r.path} className="border-t border-border align-top">
                  <th scope="row" className="py-1 pr-2 font-medium">
                    {labelForPath(record.kind, r.path)}
                    {r.path.includes('.') && <span className="block text-[11px] font-normal text-muted">{r.path}</span>}
                  </th>
                  <td className="py-1 pr-2 [overflow-wrap:anywhere]">{r.now}</td>
                  <td className="py-1 [overflow-wrap:anywhere]">{r.next}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 30 && <p className="mt-1 text-xs text-muted">…and {rows.length - 30} more.</p>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={onUse}>
          Use new
        </Button>
        <Button size="sm" disabled={busy} onClick={onKeep}>
          Keep mine
        </Button>
      </div>
    </section>
  );
}

/** Tests: forget which books' stats were shown in this tab. */
export function resetShownBooks(): void {
  useShownBooks.setState({ shown: {} });
}
