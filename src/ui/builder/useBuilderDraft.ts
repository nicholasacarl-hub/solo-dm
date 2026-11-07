/**
 * Builder draft state, kept in sessionStorage per campaign so a refresh (or a detour to Settings)
 * doesn't lose the player's progress.
 */
import { useCallback, useEffect, useState } from 'react';
import { BUILDER_STEPS, emptyDraft, type BuilderDraft } from './types';

const PREFIX = 'solo-dm:builder-draft:';

export function draftKey(campaignId: string): string {
  return `${PREFIX}${campaignId}`;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a saved draft, filling any fields added since it was saved. Invalid data yields null. */
export function readDraft(campaignId: string): BuilderDraft | null {
  try {
    const raw = storage()?.getItem(draftKey(campaignId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    const draft = { ...emptyDraft(), ...parsed } as BuilderDraft;
    if (!BUILDER_STEPS.includes(draft.step)) draft.step = 'class';
    return draft;
  } catch {
    return null;
  }
}

export function writeDraft(campaignId: string, draft: BuilderDraft): void {
  try {
    storage()?.setItem(draftKey(campaignId), JSON.stringify(draft));
  } catch {
    // Storage full or blocked: the draft still lives in memory.
  }
}

export function clearDraft(campaignId: string): void {
  try {
    storage()?.removeItem(draftKey(campaignId));
  } catch {
    // ignore
  }
}

export function useBuilderDraft(campaignId: string): {
  draft: BuilderDraft;
  setDraft: (next: BuilderDraft | ((d: BuilderDraft) => BuilderDraft)) => void;
  resetDraft: () => void;
} {
  const [draft, setDraftState] = useState<BuilderDraft>(() => readDraft(campaignId) ?? emptyDraft());
  useEffect(() => writeDraft(campaignId, draft), [campaignId, draft]);
  const setDraft = useCallback((next: BuilderDraft | ((d: BuilderDraft) => BuilderDraft)) => setDraftState(next), []);
  const resetDraft = useCallback(() => {
    clearDraft(campaignId);
    setDraftState(emptyDraft());
  }, [campaignId]);
  return { draft, setDraft, resetDraft };
}
