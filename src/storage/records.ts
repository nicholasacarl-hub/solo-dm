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

export async function putCharacter(c: Character): Promise<void> {
  await db.characters.put(c);
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
