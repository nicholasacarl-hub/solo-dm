/**
 * Describe what the player changed in the table rules, so the DM can be told mid-session (the
 * session's system prompt is frozen, so changes travel as a DM notice).
 */
import type { CampaignSettings, PlayerRollMode } from '@/types';

const ROLL_MODE: Record<PlayerRollMode, string> = {
  auto: 'automatic',
  prompt: 'tap to roll',
  physical: 'physical dice',
};

const MAX_TEXT = 400;

function quote(text: string): string {
  const t = text.trim();
  return `"${t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t}"`;
}

function listDiff(label: string, before: string[], after: string[], addedHint: string): string[] {
  const key = (s: string) => s.trim().toLowerCase();
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const added = after.filter((s) => !beforeKeys.has(key(s)));
  const removed = before.filter((s) => !afterKeys.has(key(s)));
  const lines: string[] = [];
  if (added.length) lines.push(`new ${label} (${addedHint}): ${added.map(quote).join(', ')}`);
  if (removed.length) lines.push(`${label} removed: ${removed.map(quote).join(', ')}`);
  return lines;
}

function enumDiff(label: string, before: string, after: string): string[] {
  return before === after ? [] : [`${label}: ${before} → ${after}`];
}

/** One short line per change, e.g. "difficulty: standard → hard". Empty when nothing changed. */
export function describeSettingsChanges(before: CampaignSettings, after: CampaignSettings): string[] {
  const lines: string[] = [
    ...enumDiff('rules fidelity', before.rulesFidelity, after.rulesFidelity),
    ...enumDiff('homebrew freedom', before.homebrewFreedom, after.homebrewFreedom),
    ...enumDiff('difficulty', before.difficulty, after.difficulty),
    ...enumDiff('narration length', before.narrationLength, after.narrationLength),
    ...enumDiff('player rolls', ROLL_MODE[before.playerRollMode], ROLL_MODE[after.playerRollMode]),
  ];
  if (before.showDmRolls !== after.showDmRolls) {
    lines.push(
      after.showDmRolls ? 'DM rolls are now shown to the player' : 'DM rolls are now hidden behind the screen',
    );
  }
  if (before.milestoneLeveling !== after.milestoneLeveling) {
    lines.push(
      `leveling: ${before.milestoneLeveling ? 'milestone' : 'XP'} → ${after.milestoneLeveling ? 'milestone' : 'XP'}`,
    );
  }
  if (before.tone.trim() !== after.tone.trim()) lines.push(`tone is now ${quote(after.tone)}`);
  if (before.setting.trim() !== after.setting.trim()) lines.push(`setting notes are now ${quote(after.setting)}`);
  lines.push(...listDiff('lines', before.lines, after.lines, 'never include'));
  lines.push(...listDiff('veils', before.veils, after.veils, 'keep off-screen'));
  const sources = (s: CampaignSettings) => [...s.enabledSources].sort().join('\n');
  if (sources(before) !== sources(after)) {
    lines.push(`rules sources changed (${after.enabledSources.length} enabled besides the SRD)`);
  }
  if ((before.playerNotes ?? '').trim() !== (after.playerNotes ?? '').trim()) {
    lines.push(after.playerNotes?.trim() ? `player notes are now ${quote(after.playerNotes)}` : 'player notes cleared');
  }
  return lines;
}

/** The DM notice for a set of changes. */
export function settingsChangeNotice(changes: string[]): string {
  return `The player changed the table rules: ${changes.join('; ')}. Follow the new rules from now on.`;
}
