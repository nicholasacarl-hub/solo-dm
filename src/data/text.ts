/**
 * Small text helpers shared by the rules index and the import pipeline.
 */

/** Markdown to one line of plain text (for snippets and summaries). */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^ {0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inline Markdown to plain text, keeping line breaks. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/[*_`]/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** The first sentence of plain text, at most `max` characters. */
export function firstSentence(text: string, max = 160): string {
  const plain = text.replace(/\s+/g, ' ').trim();
  const match = /^(.+?[.!?])(?=\s|$)/.exec(plain);
  const sentence = match ? match[1] : plain;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A DOMException('AbortError') when the signal was aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function abortError(): DOMException {
  return new DOMException('The import was cancelled.', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}
