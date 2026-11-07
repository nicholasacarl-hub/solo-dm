/**
 * What this browser knows about its last GitHub sync, per repository target and campaign.
 * Stored in localStorage under 'solo-dm:github-sync' (small; never contains save data).
 */
import { z } from 'zod';

export const SYNC_STATE_KEY = 'solo-dm:github-sync';

export interface CampaignSyncEntry {
  /** Blob sha of the save file on GitHub right after the last sync. */
  remoteSha: string;
  /** campaign.updatedAt of the local copy at the last sync. */
  localUpdatedAt: number;
  syncedAt: number;
  /** Set when the campaign was deleted on this device after syncing; sync won't pull it back unless it changes on GitHub. */
  deletedAt?: number;
}

export interface RemoteSaveMeta {
  campaignId: string;
  name: string;
  updatedAt: number;
}

export interface TargetSyncState {
  campaigns: Record<string, CampaignSyncEntry>;
  /** Save-file metadata by blob sha, so unchanged saves are not downloaded again. */
  remoteMeta: Record<string, RemoteSaveMeta>;
}

const entrySchema = z.object({
  remoteSha: z.string(),
  localUpdatedAt: z.number(),
  syncedAt: z.number(),
  deletedAt: z.number().optional(),
});
const metaSchema = z.object({ campaignId: z.string(), name: z.string(), updatedAt: z.number() });
const targetSchema = z.object({
  campaigns: z.record(z.string(), entrySchema),
  remoteMeta: z.record(z.string(), metaSchema),
});
const stateSchema = z.object({ version: z.literal(1), targets: z.record(z.string(), targetSchema) });

type StoredSyncState = z.infer<typeof stateSchema>;

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readState(): StoredSyncState {
  try {
    const raw = localStore()?.getItem(SYNC_STATE_KEY);
    if (raw) {
      const parsed = stateSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // Unreadable state: start over (sync then falls back to "newer side wins").
  }
  return { version: 1, targets: {} };
}

function writeState(state: StoredSyncState): void {
  try {
    localStore()?.setItem(SYNC_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[storage] Could not save the GitHub sync state:', error);
  }
}

/** Identifies one sync destination: the same campaign may be synced to several repos or folders. */
export function syncTargetKey(owner: string, repo: string, branch: string, path: string): string {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${branch}:${path}`;
}

export function loadTargetState(key: string): TargetSyncState {
  const target = readState().targets[key];
  return {
    campaigns: { ...(target?.campaigns ?? {}) },
    remoteMeta: { ...(target?.remoteMeta ?? {}) },
  };
}

export function saveTargetState(key: string, target: TargetSyncState): void {
  const state = readState();
  state.targets[key] = target;
  writeState(state);
}

/** Remember that a synced campaign was deleted here, so the next sync doesn't resurrect it. */
export function markCampaignDeleted(campaignId: string, now = Date.now()): void {
  const state = readState();
  let changed = false;
  for (const target of Object.values(state.targets)) {
    const entry = target.campaigns[campaignId];
    if (entry && entry.deletedAt === undefined) {
      entry.deletedAt = now;
      changed = true;
    }
  }
  if (changed) writeState(state);
}
