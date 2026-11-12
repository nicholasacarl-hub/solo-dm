/**
 * Text helpers for DM narration: the ```choices suggestion block, OOC wrapping, and splitting
 * the end-of-session text into the recap and the DM's private notes.
 */

import { safeEnd } from '@/lib/text';

const CHOICES_BLOCK = /```[ \t]*choices[^\n]*\n([\s\S]*?)(?:\n?```[ \t]*|$)/gi;
const CHOICES_OPEN = /```[ \t]*choices\b/i;
const MAX_CHOICES = 4;
const MAX_CHOICE_LENGTH = 80;

export interface ParsedNarration {
  /** Narration with every choices block removed. */
  text: string;
  /** Suggestions from the last choices block (undefined when there is none). */
  choices?: string[];
}

function cleanChoice(line: string): string {
  return line
    .trim()
    .replace(/^(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .trim()
    .slice(0, MAX_CHOICE_LENGTH);
}

/** Pull a ```choices fenced block (normally trailing) out of narration. */
export function parseChoices(raw: string): ParsedNarration {
  let choices: string[] | undefined;
  const text = raw.replace(CHOICES_BLOCK, (_match, body: string) => {
    const lines = body
      .split('\n')
      .map(cleanChoice)
      .filter((line) => line.length > 0);
    choices = lines.slice(0, MAX_CHOICES);
    return '';
  });
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  return choices && choices.length > 0 ? { text: cleaned, choices } : { text: cleaned };
}

/** While text streams, hide a choices block that has started but not finished. */
export function visibleWhileStreaming(raw: string): string {
  const open = raw.search(CHOICES_OPEN);
  const head = open >= 0 ? raw.slice(0, open) : raw;
  // A lone trailing fence may be the start of a choices block; hide it until we know.
  return head.replace(/`{1,3}[a-z]*$/i, '').trimEnd();
}

const OOC_PREFIX = /^\s*\(?\s*ooc\s*[:)]\s*/i;

export function isOoc(text: string): boolean {
  return OOC_PREFIX.test(text);
}

/** Player words as sent to Claude: "OOC: …" becomes "<ooc>…</ooc>". */
export function playerTextForModel(text: string): string {
  const trimmed = text.trim();
  if (!isOoc(trimmed)) return trimmed;
  return `<ooc>${trimmed.replace(OOC_PREFIX, '').trim()}</ooc>`;
}

export interface SessionWrapUp {
  recap: string;
  dmNotes: string | null;
}

const RECAP_HEADING = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)recap\b[^\n]*$/im;
const NOTES_HEADING = /^[ \t]*(?:#{1,6}[ \t]*|\*\*)dm[ \t-]*notes?\b[^\n]*$/im;

/** Split the wrap-up text into "## Recap" and "## DM Notes". Without headings the whole text is the recap. */
export function parseWrapUp(raw: string): SessionWrapUp {
  const text = parseChoices(raw).text;
  const recapMatch = RECAP_HEADING.exec(text);
  const notesMatch = NOTES_HEADING.exec(text);
  if (!recapMatch && !notesMatch) return { recap: text.trim(), dmNotes: null };

  const recapStart = recapMatch ? recapMatch.index + recapMatch[0].length : 0;
  const notesStart = notesMatch ? notesMatch.index + notesMatch[0].length : -1;
  const recapEnd = notesMatch && notesMatch.index > recapStart ? notesMatch.index : text.length;
  const recap = (recapMatch ? text.slice(recapStart, recapEnd) : text.slice(0, notesMatch?.index ?? text.length)).trim();
  let dmNotes: string | null = null;
  if (notesMatch) {
    const notesEnd = recapMatch && recapMatch.index > notesStart ? recapMatch.index : text.length;
    dmNotes = text.slice(notesStart, notesEnd).trim() || null;
  }
  return { recap: recap || text.trim(), dmNotes };
}

/** Word-safe shortening for log summaries. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Never inside an emoji: a lone half of a surrogate pair isn't valid text in a request.
  const cut = clean.slice(0, safeEnd(clean, max - 1));
  const space = clean[cut.length] === ' ' ? cut.length : cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
