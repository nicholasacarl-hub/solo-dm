/**
 * Give a campaign and everything it owns fresh ids, rewriting every reference to match.
 * Used to duplicate a save slot and to import a bundle as a copy.
 */
import type { Character, CombatState } from '@/types';
import { newId } from '@/lib/id';
import type { CampaignData } from './types';

/** Lazily assigns one fresh id per old id, so references to the same record stay together. */
class IdMap {
  private readonly map = new Map<string, string>();

  constructor(private readonly fresh: (oldId: string) => string = () => newId()) {}

  get(oldId: string): string {
    let id = this.map.get(oldId);
    if (id === undefined) {
      id = this.fresh(oldId);
      this.map.set(oldId, id);
    }
    return id;
  }

  /** Map an optional reference only when it points at a record this map knows about. */
  ref<T extends string | undefined>(oldId: T): T {
    return (oldId !== undefined && this.map.has(oldId) ? this.map.get(oldId) : oldId) as T;
  }
}

/** Homebrew ids keep their "hb:" prefix so they still read as homebrew compendium ids. */
const freshHomebrewId = (oldId: string) => (oldId.startsWith('hb:') ? `hb:${newId()}` : newId());

function remapCharacter(c: Character, id: string, campaignId: string, homebrew: IdMap): Character {
  const spellcasting = c.spellcasting && {
    ...c.spellcasting,
    spells: c.spellcasting.spells.map((s) => ({
      ...s,
      id: homebrew.ref(s.id),
      ...(s.homebrewId !== undefined && { homebrewId: homebrew.ref(s.homebrewId) }),
    })),
  };
  return {
    ...c,
    id,
    campaignId,
    features: c.features.map((f) => (f.homebrewId === undefined ? f : { ...f, homebrewId: homebrew.ref(f.homebrewId) })),
    inventory: c.inventory.map((item) => ({
      ...item,
      ...(item.homebrewId !== undefined && { homebrewId: homebrew.ref(item.homebrewId) }),
      ...(item.compendiumId !== undefined && { compendiumId: homebrew.ref(item.compendiumId) }),
    })),
    ...(spellcasting && { spellcasting }),
  };
}

function remapCombat(state: CombatState, homebrew: IdMap): CombatState {
  return {
    ...state,
    combatants: state.combatants.map((c) =>
      c.statBlockId === undefined ? c : { ...c, statBlockId: homebrew.ref(c.statBlockId) },
    ),
  };
}

export interface RemapOptions {
  /** New campaign name (defaults to the current one). */
  name?: string;
  /** Timestamp for the copy's createdAt / updatedAt. */
  now?: number;
}

/** Deep copy of a campaign's records under fresh ids. The input is not modified. */
export function remapCampaignData(source: CampaignData, opts: RemapOptions = {}): CampaignData {
  const data = structuredClone(source);
  const now = opts.now ?? Date.now();
  const campaignId = newId();
  const sessions = new IdMap();
  const homebrew = new IdMap(freshHomebrewId);
  // Assign homebrew ids first so references from the character and combat resolve to them.
  for (const h of data.homebrew) homebrew.get(h.id);
  const characterId = data.character ? newId() : null;
  const { campaign } = data;

  return {
    campaign: {
      ...campaign,
      id: campaignId,
      name: opts.name ?? campaign.name,
      characterId,
      activeSessionId: campaign.activeSessionId === null ? null : sessions.get(campaign.activeSessionId),
      createdAt: now,
      updatedAt: now,
    },
    character: data.character && characterId ? remapCharacter(data.character, characterId, campaignId, homebrew) : null,
    sessions: data.sessions.map((s) => ({ ...s, id: sessions.get(s.id), campaignId })),
    transcript: data.transcript.map((m) => ({ ...m, id: newId(), sessionId: sessions.get(m.sessionId) })),
    log: data.log.map((e) => ({
      ...e,
      id: newId(),
      campaignId,
      sessionId: e.sessionId === null ? null : sessions.get(e.sessionId),
    })),
    combat: data.combat && remapCombat(data.combat, homebrew),
    journal: data.journal.map((j) => ({ ...j, id: newId(), campaignId })),
    quests: data.quests.map((q) => ({ ...q, id: newId(), campaignId })),
    clocks: data.clocks.map((c) => ({ ...c, id: newId(), campaignId })),
    homebrew: data.homebrew.map((h) => ({ ...h, id: homebrew.get(h.id), campaignId })),
  };
}
