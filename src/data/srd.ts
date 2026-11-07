/**
 * Loaders for the generated SRD 5.2.1 files in public/srd/ (see scripts/build-srd.mjs).
 * Files are fetched relative to the app's base URL, so they work under a GitHub Pages subpath,
 * and each file is fetched at most once per page load (failed loads are retried on the next call).
 */
import { CONTENT_KINDS, type BuilderData, type CompendiumEntry, type ContentKind } from '@/types';
import { errorMessage } from './text';

export interface SrdManifest {
  version: string;
  /** ISO date (YYYY-MM-DD) the files were generated. */
  generatedAt: string;
  /** Number of compendium entries by kind. */
  counts: Partial<Record<ContentKind, number>>;
  /** The CC-BY-4.0 attribution statement (same text as SRD_ATTRIBUTION). */
  attribution: string;
  sources: { name: string; url: string; commit: string }[];
  modifications: string;
}

/** URL of a file in public/srd/ under the app's base path ("/" locally, "/<repo>/" on GitHub Pages). */
export function srdUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}srd/${file}`;
}

async function fetchSrdJson(file: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(srdUrl(file));
  } catch (err) {
    throw new Error(`Couldn't load the SRD rules (${file}): ${errorMessage(err)}. Check your connection and reload.`);
  }
  if (!response.ok) {
    throw new Error(`Couldn't load the SRD rules (${file}): the server answered ${response.status}.`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`The SRD rules file ${file} is damaged (it isn't valid JSON). Try reloading the page.`);
  }
}

const cache = new Map<string, Promise<unknown>>();

function cached<T>(file: string, parse: (raw: unknown) => T): Promise<T> {
  const hit = cache.get(file) as Promise<T> | undefined;
  if (hit) return hit;
  const promise = fetchSrdJson(file).then(parse);
  cache.set(file, promise);
  // Forget failures so the next call tries again (e.g. after the connection comes back).
  promise.catch(() => {
    if (cache.get(file) === promise) cache.delete(file);
  });
  return promise;
}

const KINDS = new Set<string>(CONTENT_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCompendiumEntry(value: unknown): value is CompendiumEntry {
  if (!isRecord(value)) return false;
  const { id, sourceId, sourceName, kind, name, text, summary, path, data } = value;
  return (
    typeof id === 'string' &&
    typeof sourceId === 'string' &&
    typeof sourceName === 'string' &&
    typeof kind === 'string' &&
    KINDS.has(kind) &&
    typeof name === 'string' &&
    typeof text === 'string' &&
    (summary === undefined || typeof summary === 'string') &&
    (path === undefined || (Array.isArray(path) && path.every((p) => typeof p === 'string'))) &&
    (data === undefined || isRecord(data))
  );
}

function parseCompendium(raw: unknown): CompendiumEntry[] {
  if (!Array.isArray(raw)) throw new Error('The SRD rules file compendium.json is damaged (expected a list of entries).');
  const entries = raw.filter(isCompendiumEntry);
  if (entries.length < raw.length) {
    console.warn(`SRD compendium: skipped ${raw.length - entries.length} malformed entries.`);
  }
  return entries;
}

function parseBuilderData(raw: unknown): BuilderData {
  const lists = ['classes', 'species', 'backgrounds', 'feats', 'equipment'] as const;
  if (!isRecord(raw) || !lists.every((key) => Array.isArray(raw[key]))) {
    throw new Error('The SRD rules file builder.json is damaged (missing classes, species, backgrounds, feats or equipment).');
  }
  return raw as unknown as BuilderData;
}

function parseManifest(raw: unknown): SrdManifest {
  if (!isRecord(raw) || typeof raw.version !== 'string' || typeof raw.attribution !== 'string') {
    throw new Error('The SRD rules file manifest.json is damaged.');
  }
  return raw as unknown as SrdManifest;
}

/** Every SRD 5.2.1 compendium entry (rules sections, spells, monsters, items...). */
export function loadSrdCompendium(): Promise<CompendiumEntry[]> {
  return cached('compendium.json', parseCompendium);
}

export function loadSrdBuilderData(): Promise<BuilderData> {
  return cached('builder.json', parseBuilderData);
}

/** Version, entry counts, attribution and upstream sources of the bundled SRD data. */
export function loadSrdManifest(): Promise<SrdManifest> {
  return cached('manifest.json', parseManifest);
}

/** Tests only: forget every cached file. */
export function resetSrdCache(): void {
  cache.clear();
}
