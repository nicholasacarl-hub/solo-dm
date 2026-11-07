/**
 * Test helpers: complete campaign graphs (built from src/test/fixtures) and a database reset.
 * Only imported by tests.
 */
import type { Campaign, Character, HomebrewEntry, TranscriptMessage } from '@/types';
import {
  sampleCampaign,
  sampleCharacter,
  sampleClocks,
  sampleCombat,
  sampleJournal,
  sampleLog,
  sampleQuests,
  sampleSession,
} from '@/test/fixtures';
import { db } from './db';
import { writeCampaignData } from './campaignData';
import type { CampaignData } from './types';

export async function resetDatabase(): Promise<void> {
  await Promise.all(db.tables.map((table) => table.clear()));
  localStorage.clear();
}

export interface GraphOptions {
  campaign?: Partial<Campaign>;
  character?: Partial<Character>;
}

/**
 * One campaign with every kind of record, two sessions (the second active) and campaign homebrew
 * referenced from the sheet and the combat tracker. Every id is prefixed with `tag`.
 */
export function campaignGraph(tag = 'a', opts: GraphOptions = {}): CampaignData {
  const id = (s: string) => `${tag}-${s}`;
  const campaignId = id('camp');
  const [s1, s2] = [id('sess-1'), id('sess-2')];
  const homebrewId = `hb:${tag}-fireblade`;
  const base = sampleCharacter();
  const homebrew: HomebrewEntry = {
    id: homebrewId,
    sourceId: 'homebrew',
    sourceName: 'Homebrew',
    kind: 'magic-item',
    name: 'Fireblade',
    text: 'A +1 longsword that sheds bright light.',
    campaignId,
    origin: 'dm',
    status: 'active',
    createdAt: 5,
    updatedAt: 5,
  };
  const message = (mid: string, sessionId: string, seq: number, role: 'user' | 'assistant'): TranscriptMessage => ({
    id: id(mid),
    sessionId,
    seq,
    param: role === 'user' ? { role, content: `Player turn ${mid}` } : { role, content: [{ type: 'text', text: `DM reply ${mid}` }] },
    createdAt: 1_700_000_000_000 + seq,
  });
  const combat = sampleCombat();
  return {
    campaign: sampleCampaign({
      id: campaignId,
      name: `Campaign ${tag}`,
      characterId: id('char'),
      activeSessionId: s2,
      sessionCount: 2,
      ...opts.campaign,
    }),
    character: sampleCharacter({
      id: id('char'),
      campaignId,
      features: [
        ...base.features,
        { id: id('feat-hb'), name: 'Fireblade Training', source: 'homebrew', description: 'Homebrew.', homebrewId },
      ],
      inventory: [
        ...base.inventory,
        { id: id('item-hb'), name: 'Fireblade', quantity: 1, magic: true, homebrewId, compendiumId: homebrewId },
      ],
      ...opts.character,
    }),
    sessions: [
      sampleSession({ id: s1, campaignId, number: 1, status: 'ended', endedAt: 1_700_000_500_000, recap: 'Recap 1' }),
      sampleSession({ id: s2, campaignId, number: 2, status: 'active', startedAt: 1_700_001_000_000 }),
    ],
    transcript: [
      message('t1', s1, 1, 'user'),
      message('t2', s1, 2, 'assistant'),
      message('t3', s2, 1, 'user'),
      message('t4', s2, 2, 'assistant'),
      message('t5', s2, 3, 'user'),
    ],
    log: sampleLog().map((e) => ({ ...e, id: id(e.id), campaignId, sessionId: e.seq <= 6 ? s1 : s2 })),
    combat: {
      ...combat,
      combatants: combat.combatants.map((c) => (c.id === 'c-2' ? { ...c, statBlockId: homebrewId } : c)),
    },
    journal: sampleJournal().map((j) => ({ ...j, id: id(j.id), campaignId })),
    quests: sampleQuests().map((q) => ({ ...q, id: id(q.id), campaignId })),
    clocks: sampleClocks().map((c) => ({ ...c, id: id(c.id), campaignId })),
    homebrew: [homebrew],
  };
}

export function sharedHomebrew(name = 'Lantern Oil'): HomebrewEntry {
  return {
    id: `hb:shared-${name}`,
    sourceId: 'homebrew',
    sourceName: 'Homebrew',
    kind: 'item',
    name,
    text: 'Burns green.',
    campaignId: null,
    origin: 'player',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Write a graph to the database and return it. */
export async function seedCampaign(tag = 'a', opts: GraphOptions = {}): Promise<CampaignData> {
  const graph = campaignGraph(tag, opts);
  await writeCampaignData(graph);
  return graph;
}

/** Every record id in a graph (campaign, character, sessions, transcript, log, journal, quests, clocks, homebrew). */
export function allIds(data: CampaignData): string[] {
  return [
    data.campaign.id,
    ...(data.character ? [data.character.id] : []),
    ...[data.sessions, data.transcript, data.log, data.journal, data.quests, data.clocks, data.homebrew].flatMap((rows) =>
      rows.map((r) => r.id),
    ),
  ];
}
