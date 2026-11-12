/**
 * The <game_state> block that opens every turn: the hero's status, the scene, combat (with the battle map's
 * positions when the fight has one), open clocks, and short cards for journal entries mentioned in the player's
 * words or the DM's last narration (cheap retrieval that keeps the DM from contradicting itself).
 */
import { characterStatusLine, summarizeCombat } from '@/engine';
import { isSeqAnswered } from '@/lib/answered';
import type { Campaign, Character, Clock, CombatState, JournalEntry } from '@/types';
import { mapStateLines } from './mapText';
import { truncate } from './narration';
import { GAME_STATE_OPEN } from './transcript';
import { formatScene, JOURNAL_KIND_LABELS } from './tools/world';

export const MAX_ENTITY_CARDS = 6;
const MIN_TERM_LENGTH = 3;

export interface GameStateInput {
  campaign: Campaign;
  character: Character | null;
  combat: CombatState | null;
  clocks: readonly Clock[];
  journal: readonly JournalEntry[];
  /** The player's words this turn (empty for app-authored turns). */
  playerText: string;
  /** The DM's most recent narration. */
  previousNarration: string;
  /**
   * True when the transcript holds the user message `seq` and an assistant message after it (isSeqAnswered): the
   * player's map moves stamped with that seq count as seen by the DM (D48). Default: only what an earlier session
   * answered (frozen as SEEN_SEQ).
   */
  answered?: (seq: number) => boolean;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-word match (Unicode-aware; whitespace inside a name may vary). */
export function mentions(text: string, term: string): boolean {
  const clean = term.trim();
  if (clean.length < MIN_TERM_LENGTH || !text) return false;
  const pattern = escapeRegExp(clean).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

function nameVariants(name: string): string[] {
  const trimmed = name.trim();
  const withoutArticle = trimmed.replace(/^(?:the|a|an)\s+/i, '');
  return withoutArticle !== trimmed && withoutArticle.length >= MIN_TERM_LENGTH ? [trimmed, withoutArticle] : [trimmed];
}

function mentionScore(entry: JournalEntry, player: string, narration: string): number {
  const names = nameVariants(entry.name);
  let score = 0;
  if (names.some((n) => mentions(player, n))) score += 4;
  if (names.some((n) => mentions(narration, n))) score += 3;
  if (entry.tags.some((t) => mentions(player, t))) score += 2;
  if (entry.tags.some((t) => mentions(narration, t))) score += 1;
  return score;
}

/** Journal entries named (or tagged) in the player's text or the last narration, best first. */
export function findMentionedEntries(
  journal: readonly JournalEntry[],
  playerText: string,
  previousNarration: string,
  max = MAX_ENTITY_CARDS,
): JournalEntry[] {
  return journal
    .map((entry) => ({ entry, score: mentionScore(entry, playerText, previousNarration) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.updatedAt - a.entry.updatedAt ||
        (a.entry.name.toLowerCase() < b.entry.name.toLowerCase() ? -1 : a.entry.name.toLowerCase() > b.entry.name.toLowerCase() ? 1 : 0),
    )
    .slice(0, max)
    .map((r) => r.entry);
}

function entityCard(entry: JournalEntry): string {
  const label = [JOURNAL_KIND_LABELS[entry.kind], entry.status?.trim()].filter(Boolean).join(', ');
  const secret = entry.secret ? ' [secret]' : '';
  return `- ${entry.name} (${label})${secret}: ${truncate(entry.summary, 240)}`;
}

function clocksLine(clocks: readonly Clock[]): string | null {
  const open = clocks.filter((c) => !c.resolved);
  if (open.length === 0) return null;
  const parts = [...open]
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
    .map((c) => `${c.name} ${c.filled}/${c.segments} (${c.kind}${c.secret ? ', secret' : ''})`);
  return `Clocks: ${parts.join(' · ')}`;
}

/** The per-turn state block (first text block of every turn-opening user message). */
export function buildGameState(input: GameStateInput): string {
  const lines: string[] = [GAME_STATE_OPEN];
  lines.push(`Hero: ${input.character ? characterStatusLine(input.character) : '(no character sheet yet)'}`);
  lines.push(`Scene: ${formatScene(input.campaign.scene)} · Tension ${input.campaign.tension}/9`);
  if (input.combat?.active) {
    lines.push(`Combat:\n${summarizeCombat(input.combat, { heroAc: input.character?.armorClass }).trim()}`);
    // The battle map: positions, reach, the current turn and the player's unseen moves (spec §5.4).
    if (input.combat.map) lines.push(...mapStateLines(input.combat, input.character, input.answered ?? ((seq) => isSeqAnswered([], seq))));
  }
  const clocks = clocksLine(input.clocks);
  if (clocks) lines.push(clocks);
  const cards = findMentionedEntries(input.journal, input.playerText, input.previousNarration);
  if (cards.length) lines.push(`Mentioned (from your journal):\n${cards.map(entityCard).join('\n')}`);
  lines.push('</game_state>');
  return lines.join('\n');
}
