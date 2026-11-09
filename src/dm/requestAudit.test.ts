/**
 * Request audit (CLAUDE.md rule 4, spec §8.2): every Messages API call lives in an audited module, and
 * the request builders never send what the rules forbid. Checked over the source text, so a new call
 * site anywhere fails here.
 */
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const isTestCode = (file: string) => /\.test\.tsx?$/.test(file) || file.includes('/testing/') || file.startsWith('/src/test/');
/** Comments removed (block comments and // comments), so the audit checklists themselves don't count. */
const code = (file: string) => SOURCES[file].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** The only app files that may call the Messages API. */
const CALL_SITES = new Set(['/src/dm/agent.ts', '/src/dm/extract/call.ts', '/src/data/vision.ts']);
const CALL = /\.messages\.(?:create|stream|parse)\s*\(|messages\.batches/;

/** The request builders: the DM's, the library's (extraction, transcription) and, until E2 moves it, vision.ts's. */
const BUILDERS = ['/src/dm/request.ts', '/src/dm/libraryRequests.ts', '/src/data/vision.ts'];
const FORBIDDEN = [/\btemperature\b/, /\btop_p\b/, /\btop_k\b/, /\btool_choice\b/, /\bbudget_tokens\b/, /type:\s*['"]disabled['"]/, /structured-outputs-/];

describe('request audit', () => {
  it('sees the source tree (sanity)', () => {
    expect(Object.keys(SOURCES)).toContain('/src/dm/agent.ts');
    expect(CALL.test(code('/src/dm/agent.ts'))).toBe(true);
  });

  it('calls messages.create / stream / parse and batches only from the audited modules', () => {
    const offenders = Object.keys(SOURCES).filter((f) => !isTestCode(f) && !CALL_SITES.has(f) && CALL.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it.each(BUILDERS.map((f) => [f]))('%s sends no sampling parameters, forced tool choice, thinking budget or structured-outputs beta', (file) => {
    const text = code(file);
    for (const pattern of FORBIDDEN) expect(pattern.test(text), String(pattern)).toBe(false);
  });
});
