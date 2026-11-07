/**
 * Saving homebrew from the Library. When the change affects the campaign loaded in the game store
 * (its own or shared homebrew), it goes through the store so memory stays in sync, and the DM gets
 * a notice on the next turn. The rules index is refreshed either way.
 */
import { deleteHomebrewRecord, putHomebrew } from '@/storage';
import { useGame } from '@/state/gameStore';
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

function affectsLoadedCampaign(entry: HomebrewEntry): boolean {
  const loaded = loadedCampaignId();
  return loaded !== null && (entry.campaignId === null || entry.campaignId === loaded);
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

function tellDm(entry: HomebrewEntry, change: HomebrewChange): void {
  try {
    useGame.getState().queueDmNotice(homebrewNotice(entry, change));
  } catch {
    // No DM session to tell; the next session's prompt includes the current homebrew.
  }
}

export async function saveHomebrewEntry(entry: HomebrewEntry, change: Exclude<HomebrewChange, 'deleted'>): Promise<void> {
  const viaStore = affectsLoadedCampaign(entry);
  if (viaStore) await useGame.getState().saveHomebrew(entry);
  else await putHomebrew(entry);
  refreshRulesIndex();
  if (viaStore) tellDm(entry, change);
}

export async function deleteHomebrewEntry(entry: HomebrewEntry): Promise<void> {
  const viaStore = affectsLoadedCampaign(entry);
  if (viaStore) await useGame.getState().deleteHomebrew(entry.id);
  else await deleteHomebrewRecord(entry.id);
  refreshRulesIndex();
  if (viaStore) tellDm(entry, 'deleted');
}
