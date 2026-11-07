/**
 * Homebrew helpers shared by the log ("View" / "Veto" on homebrew lines) and the journal's
 * Homebrew tab.
 */
import { useGame } from '@/state/gameStore';
import type { HomebrewEntry, ToolLogEntry } from '@/types';
import { toast } from '@/ui/components/toast';
import { vetoNotice } from './format';

const HOMEBREW_TOOLS = new Set(['create_homebrew', 'update_homebrew']);

export function isHomebrewLine(entry: ToolLogEntry): boolean {
  return entry.icon === 'homebrew' || HOMEBREW_TOOLS.has(entry.tool);
}

/** The homebrew whose name appears in a log summary (longest name wins: "Boon" vs "Sea Boon"). */
export function findHomebrewInText(text: string, list: HomebrewEntry[]): HomebrewEntry | undefined {
  const haystack = text.toLowerCase();
  let best: HomebrewEntry | undefined;
  for (const entry of list) {
    const name = entry.name.trim().toLowerCase();
    if (name && haystack.includes(name) && (!best || entry.name.length > best.name.length)) best = entry;
  }
  return best;
}

/**
 * Best-effort name from a summary such as `Homebrew created: "Tidecaller's Boon" (boon)` or
 * `New homebrew: Tidecaller's Boon (boon)`.
 */
export function homebrewNameFromSummary(summary: string): string {
  const quoted = summary.match(/["“]([^"”]+)["”]/);
  if (quoted) return quoted[1].trim();
  const afterColon = summary.includes(':') ? summary.slice(summary.lastIndexOf(':') + 1) : summary;
  return afterColon.replace(/\([^)]*\)\s*$/, '').trim() || summary.trim();
}

/** Tell the DM (next turn) that the player vetoed a piece of homebrew. */
export function vetoHomebrew(name: string): void {
  useGame.getState().queueDmNotice(vetoNotice(name));
  toast.info(`Veto noted. The DM will retire or rework "${name}" on your next turn.`);
}
