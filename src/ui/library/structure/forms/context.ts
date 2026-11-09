/**
 * What every review-form control needs, shared through context so the declarative groups and the
 * bespoke editors read and write the same draft.
 */
import { createContext, useContext } from 'react';
import type { CandidateBlock } from '@/data';
import type { BuilderData, CompendiumEntry, StructuredDataByKind, StructuredKind, StructuredRecord } from '@/types';

export type AnyData = StructuredDataByKind[StructuredKind];

export interface RecordFormContext {
  kind: StructuredKind;
  data: AnyData;
  /** Write one field (undefined removes an optional one). */
  set(path: string, value: unknown): void;
  /** Data paths a warning names: their labels carry a gold "Check" tag. */
  check: ReadonlySet<string>;
  /** Problems by data path, shown under the field. */
  issues: Readonly<Record<string, string>>;
  blocks: readonly CandidateBlock[];
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  builder: BuilderData | null;
  sourceId: string;
  /** This book's records (class records for "Attaches to", feats for the Origin feat list). */
  bookRecords: readonly StructuredRecord[];
  /** Subclass only: the class it attaches to (a draft field outside `data`). */
  parentClassId: string | undefined;
  setParentClassId(id: string | undefined): void;
  disabled: boolean;
  /** A control took focus: the source pane marks the words that filled it. */
  onFocusField(path: string): void;
}

export const FormContext = createContext<RecordFormContext | null>(null);

export function useRecordForm(): RecordFormContext {
  const ctx = useContext(FormContext);
  if (!ctx) throw new Error('Review form controls must be inside <RecordForm>.');
  return ctx;
}

/** A stable element id for the control of a data path ("speeds.walk" → "rf-speeds-walk"). */
export const fieldId = (path: string): string => `rf-${path.replace(/[^\w-]+/g, '-')}`;
export const issueId = (path: string): string => `${fieldId(path)}-issue`;
