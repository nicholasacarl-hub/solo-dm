/**
 * Export redaction of book text copied onto a character (spec §7.3, pure): ref'd descriptions become
 * the placeholder sentence (ref.redacted = true) and the DM's tool_use inputs that echo them are
 * replaced too — in the export copy only (rule 1: the stored campaign and transcript never change).
 * redactImportedDeep (backup.ts) then removes every wrapped lookup passage.
 *
 * CONTRACT (Day 0 stub). Owner: E1.
 */
import type { CampaignData } from './types';

export interface ExportReport { books: string[]; passages: number }

/** Pure. The export copy only: the stored campaign, character and transcript are never changed (rule 1). */
export function redactCopiedImports(data: CampaignData): { data: CampaignData; report: ExportReport } {
  void data;
  throw new Error('storage/redact: redactCopiedImports not implemented');
}
