/**
 * Offline parsers (spec §3.9): fill the same wire object Claude returns, by regex segmentation and the
 * heading scan, dispatched per kind (monster, spell, magic item, item: E2; feat, background, species,
 * class, subclass: E4, each exporting parse<Kind>(candidate) from ./feat, ./background, ./species,
 * ./classes and ./subclass). `missing` lists the wire fields left empty. emptyWire is what a reader that
 * found nothing returns (a manual "Fill in yourself" draft starts from it).
 *
 * Owner: E2 (the dispatcher).
 */
import type { StructuredKind } from '@/types';
import type { Candidate } from '../segment';
import { WIRE, type Wire } from '../wire';
import { parseBackground } from './background';
import { parseClass } from './classes';
import { parseFeat } from './feat';
import { parseItem } from './item';
import { parseMagicItem } from './magicItem';
import { parseMonster } from './monster';
import { parseSpecies } from './species';
import { parseSpell } from './spell';
import { parseSubclass } from './subclass';

export interface OfflineParse<K extends StructuredKind> {
  wire: Wire<K>;
  /** Top-level wire fields the parser couldn't fill (left at their sentinels). */
  missing: string[];
}

type KindParser<K extends StructuredKind> = (candidate: Candidate & { kind: K }) => OfflineParse<K>;
type Parsers = { [K in StructuredKind]: KindParser<K> };

const PARSERS: Parsers = {
  monster: parseMonster,
  spell: parseSpell,
  'magic-item': parseMagicItem,
  item: parseItem,
  feat: parseFeat,
  background: parseBackground,
  species: parseSpecies,
  class: (candidate) => parseClass(candidate),
  subclass: parseSubclass,
};

/** Every sentinel of a kind's wire: what a parser that read nothing returns (all key fields missing). */
export function emptyWire<K extends StructuredKind>(kind: K, name: string): Wire<K> {
  const fill = (schema: unknown): unknown => {
    const def = (schema as { def?: { type?: string; shape?: Record<string, unknown>; entries?: Record<string, string> } }).def;
    switch (def?.type) {
      case 'object':
        return Object.fromEntries(Object.entries(def.shape ?? {}).map(([k, v]) => [k, fill(v)]));
      case 'array':
        return [];
      case 'string':
        return '';
      case 'number':
        return 0;
      case 'boolean':
        return false;
      case 'enum': {
        const values = Object.values(def.entries ?? {});
        return values.find((v) => v === 'none' || v === 'unknown') ?? values.find((v) => v === 'other') ?? values[0];
      }
      default:
        return null;
    }
  };
  const wire = fill(WIRE[kind]) as Wire<K>;
  return { ...wire, matchesKind: true, name, format: 'other' } as Wire<K>;
}

export function parseOffline<K extends StructuredKind>(candidate: Candidate & { kind: K }): OfflineParse<K> {
  return (PARSERS[candidate.kind] as KindParser<K>)(candidate);
}
