/**
 * Layering guard (spec §8.2, §3.1, §7.4): the module boundaries every engineer relies on, checked over the
 * source text so a wrong edge fails here instead of becoming an import cycle or a privacy leak. App code
 * only: tests, `testing/` helpers and src/test/** may import anything.
 */
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

interface ImportEdge {
  /** Resolved module path without extension ("/src/dm/client"), or the bare specifier for packages. */
  target: string;
  typeOnly: boolean;
  dynamic: boolean;
}

const isTestCode = (file: string) => /\.test\.tsx?$/.test(file) || file.includes('/testing/') || file.startsWith('/src/test/');
const APP_FILES = Object.keys(SOURCES).filter((f) => !isTestCode(f));

/** Block comments and whole-line comments removed, so prose that mentions import('…') isn't an edge. */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function resolve(from: string, spec: string): string {
  let path: string;
  if (spec.startsWith('@/')) path = `/src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) {
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    path = parts.join('/');
  } else return spec;
  path = path.replace(/\?.*$/, '').replace(/\.(tsx?|mjs|js)$/, '');
  // A directory import means its index.
  if (!SOURCES[`${path}.ts`] && !SOURCES[`${path}.tsx`] && (SOURCES[`${path}/index.ts`] || SOURCES[`${path}/index.tsx`])) path = `${path}/index`;
  return path;
}

function importsOf(file: string): ImportEdge[] {
  const code = stripComments(SOURCES[file]);
  const edges: ImportEdge[] = [];
  const STATIC = /^[ \t]*(?:import|export)\s+(type\s+)?(?:[\w$]+\s*,\s*)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+)\s+from\s+['"]([^'"]+)['"]/gm;
  const SIDE_EFFECT = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
  const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(STATIC)) edges.push({ target: resolve(file, m[2]), typeOnly: Boolean(m[1]), dynamic: false });
  for (const m of code.matchAll(SIDE_EFFECT)) edges.push({ target: resolve(file, m[1]), typeOnly: false, dynamic: false });
  for (const m of code.matchAll(DYNAMIC)) edges.push({ target: resolve(file, m[1]), typeOnly: false, dynamic: true });
  return edges;
}

/** "file → target" for every edge of the files matching `files` whose target matches `bad`. */
function violations(files: (f: string) => boolean, bad: (edge: ImportEdge, file: string) => boolean): string[] {
  return APP_FILES.filter(files).flatMap((file) => importsOf(file).filter((e) => bad(e, file)).map((e) => `${file} → ${e.target}`));
}

const under = (dir: string) => (path: string) => path.startsWith(`${dir}/`);

describe('layering', () => {
  it('sees the source tree (sanity)', () => {
    expect(APP_FILES).toContain('/src/data/index.ts');
    expect(importsOf('/src/data/vision.ts').map((e) => e.target)).toContain('/src/dm/client');
  });

  it('src/data never imports src/dm, except vision.ts → @/dm/client and @/dm/libraryRequests', () => {
    const allowed = new Set(['/src/dm/client', '/src/dm/libraryRequests']);
    expect(
      violations(under('/src/data'), (e, file) => under('/src/dm')(e.target) && !(file === '/src/data/vision.ts' && allowed.has(e.target))),
    ).toEqual([]);
  });

  it('nothing outside src/ui imports src/ui (the app entry points aside)', () => {
    const entry = new Set(['/src/main.tsx', '/src/App.tsx']);
    expect(violations((f) => !under('/src/ui')(f) && !entry.has(f), (e) => under('/src/ui')(e.target))).toEqual([]);
  });

  it('campaign exports and sync never import the pack module (book data stays out of saves)', () => {
    const saves = new Set(['/src/storage/backup.ts', '/src/storage/campaignData.ts', '/src/storage/githubSync.ts']);
    expect(violations((f) => saves.has(f), (e) => e.target === '/src/data/structured/packs')).toEqual([]);
  });

  it('nor reach it through other modules (no path from a save to the pack module)', () => {
    const fileOf = (target: string) => [`${target}.ts`, `${target}.tsx`].find((f) => SOURCES[f] !== undefined);
    const seen = new Set<string>();
    const queue = ['/src/storage/backup.ts', '/src/storage/campaignData.ts', '/src/storage/githubSync.ts'];
    while (queue.length) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const edge of importsOf(file)) {
        if (edge.typeOnly) continue;
        const next = fileOf(edge.target);
        if (next && !seen.has(next)) queue.push(next);
      }
    }
    expect([...seen].filter((f) => f.startsWith('/src/data/structured/packs'))).toEqual([]);
    expect(seen.has('/src/storage/redact.ts')).toBe(true);
  });

  it('the extraction request modules and the wire leaf never import the @/data or @/dm barrels', () => {
    const leaves = new Set([
      '/src/dm/libraryRequests.ts',
      '/src/dm/extract/format.ts',
      '/src/dm/extract/prompts.ts',
      '/src/data/structured/wire.ts',
      '/src/data/structured/schemas.ts',
    ]);
    const barrels = new Set(['/src/data/index', '/src/dm/index']);
    expect(violations((f) => leaves.has(f), (e) => barrels.has(e.target))).toEqual([]);
  });

  it('the game store reaches @/data only through a dynamic import (no static gameStore → @/data edge)', () => {
    expect(
      violations((f) => f === '/src/state/gameStore.ts', (e) => under('/src/data')(e.target) && !e.typeOnly && !e.dynamic),
    ).toEqual([]);
  });

  it('the engine stays pure: no storage, state, data, DM, images or UI imports', () => {
    const io = ['/src/storage', '/src/state', '/src/data', '/src/dm', '/src/images', '/src/ui'];
    expect(violations(under('/src/engine'), (e) => io.some((dir) => under(dir)(e.target)))).toEqual([]);
  });
});
