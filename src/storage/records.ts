/**
 * Low-level record access used by the game store. These write exactly what they are given;
 * keeping campaign.updatedAt current is the caller's job (the game store does it).
 */
import type {
  Campaign,
  Character,
  Clock,
  CombatState,
  JournalEntry,
  LogEntry,
  Quest,
  Session,
  TranscriptMessage,
} from '@/types';
import { noticesAddedSince, repeatsNewest } from '@/lib/dmNotices';
import { campaignTables, db, ownerRange } from './db';
import { byCreatedAt } from './campaignData';
import { listHomebrew } from './library';
import type { CampaignRecords } from './types';

export function loadCampaignRecords(campaignId: string): Promise<CampaignRecords | null> {
  return db.transaction('r', campaignTables(), async () => {
    const campaign = await db.campaigns.get(campaignId);
    if (!campaign) return null;
    const [character, sessions, transcript, log, combat, journal, quests, clocks, homebrew] = await Promise.all([
      campaign.characterId ? db.characters.get(campaign.characterId) : undefined,
      db.sessions.where('[campaignId+number]').between(...ownerRange(campaignId)).toArray(),
      campaign.activeSessionId ? getTranscript(campaign.activeSessionId) : [],
      db.log.where('[campaignId+seq]').between(...ownerRange(campaignId)).toArray(),
      db.combat.get(campaignId),
      db.journal.where('campaignId').equals(campaignId).toArray(),
      db.quests.where('campaignId').equals(campaignId).toArray(),
      db.clocks.where('campaignId').equals(campaignId).toArray(),
      listHomebrew(campaignId),
    ]);
    return {
      campaign,
      character: character ?? null,
      sessions,
      transcript,
      log,
      combat: combat?.state ?? null,
      journal: journal.sort(byCreatedAt),
      quests: quests.sort(byCreatedAt),
      clocks: clocks.sort(byCreatedAt),
      homebrew,
    };
  });
}

export async function putCampaign(c: Campaign): Promise<void> {
  await db.campaigns.put(c);
}

/**
 * Save a campaign record without losing DM notices queued elsewhere (the Library, another tab) since the caller last
 * saw the record. `seen` is the stored list as the caller last saw it, repeats and order included: the stored notices
 * beyond it (noticesAddedSince, so a repeat of a notice it saw counts as new) are kept after the record's own. Returns
 * the notices now stored.
 */
export function putCampaignKeepingNotices(c: Campaign, seen: readonly string[]): Promise<string[]> {
  return db.transaction('rw', db.campaigns, async () => {
    const stored = await db.campaigns.get(c.id);
    const own = c.pendingDmNotices ?? [];
    const queuedElsewhere = noticesAddedSince(stored?.pendingDmNotices ?? [], seen);
    const next: Campaign = queuedElsewhere.length > 0 ? { ...c, pendingDmNotices: [...own, ...queuedElsewhere] } : c;
    await db.campaigns.put(next);
    return next.pendingDmNotices ?? [];
  });
}

/**
 * Add a note for the DM to a stored campaign, bumping its updatedAt to at least `updatedAt`. A note that repeats the
 * newest one stored is a retry and isn't added again; any other repeat is a new note (a change made, undone and made
 * again). With `once`, a note stored anywhere isn't added again either: for a note that states a fact the app finds
 * again until it is saved. Returns the notices now stored, or null when the campaign doesn't exist (it is never
 * created).
 */
export function addPendingDmNotice(
  campaignId: string,
  notice: string,
  updatedAt = Date.now(),
  opts: { once?: boolean } = {},
): Promise<string[] | null> {
  return db.transaction('rw', db.campaigns, async () => {
    const stored = await db.campaigns.get(campaignId);
    if (!stored) return null;
    const notices = stored.pendingDmNotices ?? [];
    if (opts.once ? notices.includes(notice) : repeatsNewest(notices, notice)) return notices;
    const next: Campaign = {
      ...stored,
      pendingDmNotices: [...notices, notice],
      updatedAt: Math.max(updatedAt, stored.updatedAt + 1),
    };
    await db.campaigns.put(next);
    return [...notices, notice];
  });
}

export async function putCharacter(c: Character): Promise<void> {
  await db.characters.put(c);
}

/** One stored character record, or undefined. */
export async function getCharacter(id: string): Promise<Character | undefined> {
  return db.characters.get(id);
}

/** Delete one character record (e.g. after the campaign's character was replaced). */
export async function deleteCharacterRecord(id: string): Promise<void> {
  await db.characters.delete(id);
}

export async function putSession(s: Session): Promise<void> {
  await db.sessions.put(s);
}

export async function putTranscript(messages: TranscriptMessage[]): Promise<void> {
  await db.transcript.bulkPut(messages);
}

/** Delete the session's transcript messages with seq > `seq` (never the ones at or before it). */
export async function deleteTranscriptAfter(sessionId: string, seq: number): Promise<void> {
  const [, upper] = ownerRange(sessionId);
  await db.transcript.where('[sessionId+seq]').between([sessionId, seq], upper, false, true).delete();
}

export function getTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  return db.transcript.where('[sessionId+seq]').between(...ownerRange(sessionId)).toArray();
}

export async function putLog(entries: LogEntry[]): Promise<void> {
  await db.log.bulkPut(entries);
}

export async function deleteLog(ids: string[]): Promise<void> {
  await db.log.bulkDelete(ids);
}

/** Save the campaign's combat tracker; null removes it. */
export async function putCombat(campaignId: string, state: CombatState | null): Promise<void> {
  if (state) await db.combat.put({ campaignId, state });
  else await db.combat.delete(campaignId);
}

export async function putJournal(entries: JournalEntry[]): Promise<void> {
  await db.journal.bulkPut(entries);
}

export async function deleteJournalEntry(id: string): Promise<void> {
  await db.journal.delete(id);
}

export async function putQuest(q: Quest): Promise<void> {
  await db.quests.put(q);
}

export async function deleteQuestRecord(id: string): Promise<void> {
  await db.quests.delete(id);
}

export async function putClock(c: Clock): Promise<void> {
  await db.clocks.put(c);
}

export async function deleteClockRecord(id: string): Promise<void> {
  await db.clocks.delete(id);
}
