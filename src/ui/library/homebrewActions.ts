/**
 * Saving homebrew from the Library. When the change affects the campaign loaded in the game store
 * (its own or shared homebrew), it goes through the store so memory stays in sync. The rules index
 * is refreshed either way.
 *
 * The DM's system prompt is frozen for a session, so every campaign with a session in progress that
 * can use the entry gets a notice for its next turn. Notices are queued per campaign (persisted on
 * the campaign record), so they arrive even though the Library isn't the table: by the time the
 * player is here, the table has usually unloaded its campaign.
 */
import { deleteHomebrewRecord, listCampaigns, putHomebrew } from '@/storage';
import { queueCampaignNotice, useGame } from '@/state/gameStore';
import type { HomebrewEntry } from '@/types';
import { kindInfo, refreshRulesIndex } from './kinds';

export type HomebrewChange = 'created' | 'edited' | 'retired' | 'restored' | 'deleted';

function loadedCampaignId(): string | null {
  try {
    return useGame.getState().campaignId;
  } catch {
    return null;
  }
}

function affectsLoadedCampaign(entries: HomebrewEntry[]): boolean {
  const loaded = loadedCampaignId();
  return loaded !== null && entries.some((e) => e.campaignId === null || e.campaignId === loaded);
}

const NOTICE_TAIL: Record<HomebrewChange, string> = {
  created: 'Use get_entry to read it.',
  edited: 'Use get_entry for the current text and follow the new version.',
  retired: 'It should no longer appear in play.',
  restored: 'It is available again.',
  deleted: 'Stop using it.',
};

/** The DM notice for a player-side homebrew change. */
export function homebrewNotice(entry: HomebrewEntry, change: HomebrewChange): string {
  const kind = kindInfo(entry.kind).label.toLowerCase();
  return `The player ${change} the homebrew ${kind} “${entry.name}” in the Library. ${NOTICE_TAIL[change]}`;
}

/**
 * Campaigns whose DM should hear about a change: those with a session in progress that could use
 * any version of the entry (shared homebrew reaches every campaign). Campaigns between sessions
 * need nothing: the next session's prompt is built from the current homebrew.
 */
async function campaignsToTell(versions: HomebrewEntry[]): Promise<string[]> {
  const owners = new Set(versions.map((v) => v.campaignId));
  const summaries = await listCampaigns();
  return summaries
    .map((s) => s.campaign)
    .filter((c) => c.activeSessionId !== null && (owners.has(null) || owners.has(c.id)))
    .map((c) => c.id);
}

/** Never throws: the homebrew itself is already saved. */
async function tellDms(versions: HomebrewEntry[], notice: string): Promise<void> {
  try {
    const ids = await campaignsToTell(versions);
    const results = await Promise.allSettled(ids.map((id) => queueCampaignNotice(id, notice)));
    for (const r of results) {
      if (r.status === 'rejected') console.warn('[library] Could not queue a homebrew notice for the DM:', r.reason);
    }
  } catch (error) {
    console.warn('[library] Could not queue the homebrew notice for the DM:', error);
  }
}

/** `previous` is the stored version being replaced, so a campaign the entry moves away from hears too. */
export async function saveHomebrewEntry(
  entry: HomebrewEntry,
  change: Exclude<HomebrewChange, 'deleted'>,
  previous?: HomebrewEntry | null,
): Promise<void> {
  const versions = previous ? [entry, previous] : [entry];
  if (affectsLoadedCampaign(versions)) await useGame.getState().saveHomebrew(entry);
  else await putHomebrew(entry);
  refreshRulesIndex();
  await tellDms(versions, homebrewNotice(entry, change));
}

export async function deleteHomebrewEntry(entry: HomebrewEntry): Promise<void> {
  if (affectsLoadedCampaign([entry])) await useGame.getState().deleteHomebrew(entry.id);
  else await deleteHomebrewRecord(entry.id);
  refreshRulesIndex();
  await tellDms([entry], homebrewNotice(entry, 'deleted'));
}
