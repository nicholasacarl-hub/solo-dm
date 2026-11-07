/**
 * Whole-campaign reads, writes and deletes, shared by save slots, backups and GitHub sync.
 * Each helper opens its own transaction; called inside an outer transaction over
 * campaignTables() it joins that one instead.
 */
import { campaignTables, db } from './db';
import type { CampaignData } from './types';

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Oldest first, ties broken by id so exports are deterministic. */
export function byCreatedAt<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || compareStrings(a.id, b.id);
}

/** Read everything a campaign owns (transcripts of every session included), in a stable order. */
export function readCampaignData(campaignId: string): Promise<CampaignData | null> {
  return db.transaction('r', campaignTables(), async () => {
    const campaign = await db.campaigns.get(campaignId);
    if (!campaign) return null;
    const [character, sessions, log, combat, journal, quests, clocks, homebrew] = await Promise.all([
      campaign.characterId ? db.characters.get(campaign.characterId) : undefined,
      db.sessions.where('campaignId').equals(campaignId).toArray(),
      db.log.where('campaignId').equals(campaignId).toArray(),
      db.combat.get(campaignId),
      db.journal.where('campaignId').equals(campaignId).toArray(),
      db.quests.where('campaignId').equals(campaignId).toArray(),
      db.clocks.where('campaignId').equals(campaignId).toArray(),
      db.homebrew.where('campaignId').equals(campaignId).toArray(),
    ]);
    sessions.sort((a, b) => a.number - b.number || a.startedAt - b.startedAt);
    const sessionOrder = new Map(sessions.map((s, i) => [s.id, i]));
    const transcript = await db.transcript.where('sessionId').anyOf([...sessionOrder.keys()]).toArray();
    transcript.sort(
      (a, b) => (sessionOrder.get(a.sessionId) ?? 0) - (sessionOrder.get(b.sessionId) ?? 0) || a.seq - b.seq,
    );
    log.sort((a, b) => a.seq - b.seq);
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
      homebrew: homebrew.sort(byCreatedAt),
    };
  });
}

/** Write a campaign's records as given (ids and references must already be consistent). */
export function writeCampaignData(data: CampaignData): Promise<void> {
  return db.transaction('rw', campaignTables(), async () => {
    await Promise.all([
      db.campaigns.put(data.campaign),
      data.character ? db.characters.put(data.character) : undefined,
      db.sessions.bulkPut(data.sessions),
      db.transcript.bulkPut(data.transcript),
      db.log.bulkPut(data.log),
      data.combat ? db.combat.put({ campaignId: data.campaign.id, state: data.combat }) : undefined,
      db.journal.bulkPut(data.journal),
      db.quests.bulkPut(data.quests),
      db.clocks.bulkPut(data.clocks),
      db.homebrew.bulkPut(data.homebrew),
    ]);
  });
}

/** Delete a campaign and every record it owns. */
export function deleteCampaignData(campaignId: string): Promise<void> {
  return db.transaction('rw', campaignTables(), async () => {
    const sessionIds = await db.sessions.where('campaignId').equals(campaignId).primaryKeys();
    await Promise.all([
      db.transcript.where('sessionId').anyOf(sessionIds).delete(),
      db.sessions.where('campaignId').equals(campaignId).delete(),
      db.characters.where('campaignId').equals(campaignId).delete(),
      db.log.where('campaignId').equals(campaignId).delete(),
      db.combat.delete(campaignId),
      db.journal.where('campaignId').equals(campaignId).delete(),
      db.quests.where('campaignId').equals(campaignId).delete(),
      db.clocks.where('campaignId').equals(campaignId).delete(),
      db.homebrew.where('campaignId').equals(campaignId).delete(),
      db.campaigns.delete(campaignId),
    ]);
  });
}

/**
 * Make a campaign's records agree with each other before they are written: everything points at
 * the campaign, the character link and the active session are valid, and transcript messages of
 * unknown sessions are dropped (they could never be deleted with the campaign).
 */
export function normalizeCampaignData(data: CampaignData): CampaignData {
  const campaignId = data.campaign.id;
  const own = <T extends { campaignId: string | null }>(row: T): T =>
    row.campaignId === campaignId ? row : { ...row, campaignId };
  const sessions = data.sessions.map(own);
  const sessionIds = new Set(sessions.map((s) => s.id));
  const active = sessions.find((s) => s.id === data.campaign.activeSessionId && s.status === 'active');
  const character = data.character ? own(data.character) : null;
  return {
    campaign: { ...data.campaign, characterId: character?.id ?? null, activeSessionId: active?.id ?? null },
    character,
    sessions,
    transcript: data.transcript.filter((m) => sessionIds.has(m.sessionId)),
    log: data.log.map(own),
    combat: data.combat,
    journal: data.journal.map(own),
    quests: data.quests.map(own),
    clocks: data.clocks.map(own),
    homebrew: data.homebrew.map(own),
  };
}
