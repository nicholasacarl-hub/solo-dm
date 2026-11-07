/**
 * Ambitions: goals the player set for themselves (found a guild, take the throne). The DM tracks one
 * as a quest flagged `ambition` plus a progress clock with the same name, which only moves for what
 * the hero actually earns.
 */
import type { Clock, Quest, QuestStatus } from '@/types';

/** Case, punctuation and spacing don't make a different name: "Thieves’ Guild" = "thieves guild". */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The clock that tracks an ambition: one with the same name, a progress clock first. Hidden secrets never match. */
export function ambitionClock(quest: Pick<Quest, 'title'>, clocks: readonly Clock[], showSecrets: boolean): Clock | undefined {
  const key = nameKey(quest.title);
  if (!key) return undefined;
  const named = clocks.filter((c) => (showSecrets || !c.secret) && nameKey(c.name) === key);
  return named.find((c) => c.kind === 'progress') ?? named[0];
}

const ORDER: readonly QuestStatus[] = ['active', 'rumor', 'completed', 'failed', 'abandoned'];

/** Ambitions first in their own group (still-open ones on top); every other quest by status as before. */
export function splitAmbitions(quests: readonly Quest[]): { ambitions: Quest[]; quests: Quest[] } {
  const ambitions = quests
    .filter((q) => q.ambition)
    .map((q, i) => ({ q, i }))
    .sort((a, b) => ORDER.indexOf(a.q.status) - ORDER.indexOf(b.q.status) || a.i - b.i)
    .map(({ q }) => q);
  return { ambitions, quests: quests.filter((q) => !q.ambition) };
}

export function isClosed(status: QuestStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'abandoned';
}
