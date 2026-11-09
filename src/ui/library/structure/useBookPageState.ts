/**
 * The book page's state lives in the URL (spec §4.2), so a reload or a shared link returns to the same
 * record: ?view=review|entries, ?c=<recordId>, ?f=<filter>, ?k=<kind>, ?q=<search>, ?setup=1.
 * Defaults are left out of the URL. Rows are links that push ?c=; everything else replaces by default,
 * so Back returns to the list in one step.
 */
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { STRUCTURED_KINDS, type StructuredKind } from '@/types';
import { REVIEW_FILTERS, type ReviewFilter } from './labels';

export interface BookPageState {
  view: 'review' | 'entries';
  recordId: string | null;
  filter: ReviewFilter;
  kind: StructuredKind | null;
  q: string;
  setup: boolean;
}

export interface BookPageControls extends BookPageState {
  set(patch: Partial<BookPageState>, mode?: 'push' | 'replace'): void;
}

const isFilter = (v: string | null): v is ReviewFilter => v !== null && v in REVIEW_FILTERS;
const isKind = (v: string | null): v is StructuredKind => v !== null && (STRUCTURED_KINDS as readonly string[]).includes(v);

export function readBookPageState(params: URLSearchParams): BookPageState {
  const f = params.get('f');
  const k = params.get('k');
  return {
    view: params.get('view') === 'entries' ? 'entries' : 'review',
    recordId: params.get('c') || null,
    filter: isFilter(f) ? f : 'review',
    kind: isKind(k) ? k : null,
    q: params.get('q') ?? '',
    setup: params.get('setup') === '1',
  };
}

/** The query string for a state (defaults omitted), from the current params plus a patch. */
export function bookPageSearch(current: URLSearchParams, patch: Partial<BookPageState>): string {
  const next = { ...readBookPageState(current), ...patch };
  const p = new URLSearchParams();
  if (next.view !== 'review') p.set('view', next.view);
  if (next.recordId) p.set('c', next.recordId);
  if (next.filter !== 'review') p.set('f', next.filter);
  if (next.kind) p.set('k', next.kind);
  if (next.q) p.set('q', next.q);
  if (next.setup) p.set('setup', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * The history state of an entry a book-page list pushed (a row link): "← List" can go Back to that list.
 * A record reached any other way (a shared link, Browse's "Edit it on the book's page", "Structure as…")
 * has no such entry before it, so "← List" closes the record instead of leaving the page.
 */
export const FROM_LIST = { fromBookList: true } as const;
export const cameFromList = (state: unknown): boolean =>
  typeof state === 'object' && state !== null && (state as { fromBookList?: unknown }).fromBookList === true;

export function useBookPageState(): BookPageControls {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // Replacing the entry (next, previous, filters) keeps its history state, so "← List" still knows where it came from.
  const historyState = useRef<unknown>(location.state);
  historyState.current = location.state;
  const state = useMemo(() => readBookPageState(params), [params]);
  const set = useCallback(
    (patch: Partial<BookPageState>, mode: 'push' | 'replace' = 'replace') =>
      setParams((prev) => new URLSearchParams(bookPageSearch(prev, patch)), mode === 'replace' ? { replace: true, state: historyState.current } : {}),
    [setParams],
  );
  return useMemo(() => ({ ...state, set }), [state, set]);
}
