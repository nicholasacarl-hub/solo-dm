/**
 * The 2024 conditions (SRD 5.2.1 Rules Glossary), summarized for the sheet and the DM.
 */
import type { ConditionId } from '@/types';

export interface ConditionInfo {
  id: ConditionId;
  name: string;
  /** One sentence. */
  summary: string;
  /** Bullet-point effects paraphrased from SRD 5.2.1. */
  effects: string[];
}

export const CONDITIONS: Record<ConditionId, ConditionInfo> = {} as Record<ConditionId, ConditionInfo>;

/** Map free text ("Poisoned", "knocked prone") to a standard condition id, or null. */
export function normalizeConditionId(_input: string): ConditionId | null {
  throw new Error('not implemented');
}

/** Display name for a standard or homebrew condition id. */
export function conditionName(_id: string): string {
  throw new Error('not implemented');
}
