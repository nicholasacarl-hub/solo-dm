/**
 * The schema guard (spec §3.5): what we send as output_config.format must compile on the API (no unions,
 * no optionals, every object closed), must keep its enums enforceable (the SDK's own transform folds them
 * into descriptions), and must stay small and free of book text. One test per kind catches both failure
 * modes the designs ran into (21 unions in a nullable monster schema; enums silently dropped).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WIRE } from '@/data/structured/wire';
import { GLOAMWOOD_MARKERS, GLOAMWOOD_NAMES } from '@/test/structuredFixtures';
import { STRUCTURED_KINDS, type StructuredKind } from '@/types';
import { extractionFormat, foldEnumCase, strictSchema, structuredFormat } from './format';
import { EXTRACT_SYSTEM, KIND_NOUN, KIND_RULES } from './prompts';

type Json = Record<string, unknown>;

/** Every schema node, with a readable path. Recurses through properties, items, anyOf/allOf/oneOf and $defs. */
function nodes(node: unknown, path = '#'): { path: string; node: Json }[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const n = node as Json;
  const out = [{ path, node: n }];
  for (const [key, child] of Object.entries((n.properties ?? {}) as Json)) out.push(...nodes(child, `${path}.${key}`));
  for (const [key, child] of Object.entries((n.$defs ?? {}) as Json)) out.push(...nodes(child, `${path}.$defs.${key}`));
  if (n.items) out.push(...nodes(n.items, `${path}[]`));
  for (const k of ['anyOf', 'allOf', 'oneOf'] as const) {
    if (Array.isArray(n[k])) (n[k] as unknown[]).forEach((c, i) => out.push(...nodes(c, `${path}.${k}[${i}]`)));
  }
  return out;
}

/** Every z.enum in a zod schema with the JSON path of its node; also every wrapper the wire must not use. */
function zodWalk(schema: z.ZodType, path = '#'): { enums: { path: string; options: string[] }[]; wrappers: string[] } {
  const enums: { path: string; options: string[] }[] = [];
  const wrappers: string[] = [];
  const visit = (s: z.ZodType, p: string) => {
    if (s instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(s.shape as Record<string, z.ZodType>)) visit(child, `${p}.${key}`);
    } else if (s instanceof z.ZodArray) visit(s.element as z.ZodType, `${p}[]`);
    else if (s instanceof z.ZodEnum) enums.push({ path: p, options: s.options.map(String) });
    else if (
      s instanceof z.ZodOptional ||
      s instanceof z.ZodNullable ||
      s instanceof z.ZodUnion ||
      s instanceof z.ZodDefault ||
      s instanceof z.ZodLiteral ||
      s instanceof z.ZodRecord ||
      s instanceof z.ZodPipe
    ) {
      wrappers.push(`${p} (${s.constructor.name})`);
    } else if (!(s instanceof z.ZodString || s instanceof z.ZodNumber || s instanceof z.ZodBoolean)) {
      wrappers.push(`${p} (unexpected ${s.constructor.name})`);
    }
  };
  visit(schema, path);
  return { enums, wrappers };
}

const FORBIDDEN = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'format', 'default', '$schema', 'minItems', 'maxItems', 'uniqueItems', 'oneOf', 'not', 'if', 'then', 'else',
];

describe.each(STRUCTURED_KINDS.map((kind) => [kind] as [StructuredKind]))('extractionFormat(%s)', (kind) => {
  const format = extractionFormat(kind);
  const all = nodes(format.schema);

  it('is a closed json_schema object, memoized per kind', () => {
    expect(format.type).toBe('json_schema');
    expect(format.schema.type).toBe('object');
    expect(extractionFormat(kind)).toBe(format);
  });

  it('has no unions: no anyOf, oneOf or array-valued type anywhere', () => {
    const unions = all.filter(({ node }) => 'anyOf' in node || 'oneOf' in node || Array.isArray(node.type)).map((x) => x.path);
    expect(unions).toEqual([]);
  });

  it('has no optional properties: every object requires all its properties, in schema order', () => {
    for (const { path, node } of all) {
      if (node.type !== 'object') continue;
      expect(node.required, path).toEqual(Object.keys((node.properties ?? {}) as Json));
    }
  });

  it('sets additionalProperties: false on every object', () => {
    const open = all.filter(({ node }) => node.type === 'object' && node.additionalProperties !== false).map((x) => x.path);
    expect(open).toEqual([]);
  });

  it('keeps every z.enum of the wire as an enum keyword with the same members', () => {
    const { enums } = zodWalk(WIRE[kind]);
    expect(enums.length).toBeGreaterThan(0);
    const byPath = new Map(all.map(({ path, node }) => [path, node]));
    for (const { path, options } of enums) {
      expect(byPath.get(path)?.enum, path).toEqual(options);
      expect(options.every((o) => o === o.toLowerCase()), `${path} members are lowercase`).toBe(true);
    }
  });

  it('uses no optional, nullable, union, default or literal fields in the zod wire schema', () => {
    expect(zodWalk(WIRE[kind]).wrappers).toEqual([]);
  });

  it('carries no unenforced or unsupported keywords, and nothing was folded into a description', () => {
    for (const { path, node } of all) {
      for (const key of FORBIDDEN) expect(Object.keys(node), `${path} has ${key}`).not.toContain(key);
      expect(node.description, `${path} has a description`).toBeUndefined();
    }
  });

  it('serializes to at most 2,500 characters', () => {
    expect(JSON.stringify(format).length).toBeLessThanOrEqual(2500);
  });

  it('names every top-level wire field in the system prompt', () => {
    const missing = Object.keys(WIRE[kind].shape).filter((field) => !EXTRACT_SYSTEM[kind].includes(field));
    expect(missing).toEqual([]);
  });

  it('keeps fixture names and marker sentences out of the schema and the system prompt', () => {
    const haystacks = [JSON.stringify(format).toLowerCase(), EXTRACT_SYSTEM[kind].toLowerCase()];
    for (const text of [...GLOAMWOOD_NAMES, ...GLOAMWOOD_MARKERS]) {
      for (const hay of haystacks) expect(hay.includes(text.toLowerCase()), text).toBe(false);
    }
  });
});

describe('the system prompts', () => {
  it.each(STRUCTURED_KINDS.map((kind) => [kind] as [StructuredKind]))('%s: ≥ 600 estimated tokens, static, names its noun', (kind) => {
    const prompt = EXTRACT_SYSTEM[kind];
    expect(prompt.length / 3.2).toBeGreaterThanOrEqual(600);
    expect(prompt).not.toContain('${');
    expect(prompt).toContain(KIND_NOUN[kind]);
    expect(prompt.endsWith(KIND_RULES[kind])).toBe(true);
  });
});

describe('strictSchema', () => {
  it('folds unsupported keywords into the description, closes objects and drops $schema', () => {
    const json = structuredFormat(z.object({ n: z.int().min(1), s: z.string().max(3) })).schema;
    expect(json).not.toHaveProperty('$schema');
    expect(json.additionalProperties).toBe(false);
    const props = json.properties as Record<string, Json>;
    expect(props.n.type).toBe('integer');
    expect(props.n).not.toHaveProperty('minimum');
    expect(props.n.description).toMatch(/^\{minimum: 1, maximum: \d+\}$/);
    expect(props.s.description).toBe('{maxLength: 3}');
  });

  it('keeps enum and const keywords (unlike the SDK transform)', () => {
    expect(strictSchema({ type: 'string', enum: ['a', 'b'] })).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(strictSchema({ const: 'x' })).toEqual({ const: 'x' });
  });
});

describe('foldEnumCase', () => {
  const read = <K extends StructuredKind>(kind: K, value: unknown) => foldEnumCase(value, extractionFormat(kind).schema);

  it('maps differently cased enum values to their exact members, nested ones included', () => {
    const spell = read('spell', { school: 'EVOCATION', attack: ' Ranged ', saveAbility: 'Dex', levelText: 'Large' }) as Json;
    expect(spell).toEqual({ school: 'evocation', attack: 'ranged', saveAbility: 'dex', levelText: 'Large' });
    const item = read('magic-item', { rarity: 'Very Rare', category: 'Wondrous-Item' }) as Json;
    expect(item).toEqual({ rarity: 'very rare', category: 'wondrous-item' });
    const gear = read('item', { items: [{ category: 'Weapon', armorType: 'NONE', name: 'Club' }] }) as Json;
    expect(gear).toEqual({ items: [{ category: 'weapon', armorType: 'none', name: 'Club' }] });
  });

  it('leaves unknown values for zod to reject', () => {
    const folded = read('spell', { school: 'Necromantic' }) as Json;
    expect(folded.school).toBe('Necromantic');
    expect(WIRE.spell.shape.school.safeParse(folded.school).success).toBe(false);
  });
});
