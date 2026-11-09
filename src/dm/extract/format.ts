/**
 * zod → the strict JSON Schema sent as output_config.format. NOT the SDK's betaZodOutputFormat:
 * in SDK 1.6.0 its transform folds enum/const (and int safe-integer bounds) into descriptions
 * (lib/transform-json-schema.js), so the API would not enforce them.
 *
 * CONTRACT (Day 0), guarded by format.test.ts. Imports only zod, the wire leaf and @/types.
 */
import { z } from 'zod';
import { WIRE } from '@/data/structured/wire';
import type { StructuredKind } from '@/types';

type Json = Record<string, unknown>;
const KEEP = new Set(['type', 'properties', 'required', 'items', 'enum', 'const', 'description', 'title',
  'additionalProperties', 'anyOf', 'allOf', '$ref', '$defs']);

/** Keep supported keywords; additionalProperties: false on every object; drop $schema; fold anything else into the description. */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  const folded: string[] = [];
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$schema') continue;
    if (key === 'properties' || key === '$defs') {
      out[key] = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, strictSchema(v)]));
    } else if (key === 'items' || key === 'anyOf' || key === 'allOf') out[key] = strictSchema(value);
    else if (KEEP.has(key)) out[key] = value;
    else folded.push(`${key}: ${JSON.stringify(value)}`);
  }
  if (out.type === 'object') out.additionalProperties = false;
  if (folded.length) out.description = [out.description, `{${folded.join(', ')}}`].filter(Boolean).join('\n');
  return out;
}

export function structuredFormat(schema: z.ZodType): { type: 'json_schema'; schema: Json } {
  return { type: 'json_schema', schema: strictSchema(z.toJSONSchema(schema)) as Json };
}

const formats = new Map<StructuredKind, { type: 'json_schema'; schema: Json }>();
/** Memoized per kind: the same object (and bytes) for every request of a kind. */
export function extractionFormat(kind: StructuredKind): { type: 'json_schema'; schema: Json } {
  let f = formats.get(kind);
  if (!f) formats.set(kind, (f = structuredFormat(WIRE[kind])));
  return f;
}

/** Structured outputs don't guarantee enum capitalization: map each enum string to its exact member. */
export function foldEnumCase(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return value;
  const s = schema as Json;
  if (Array.isArray(s.enum) && typeof value === 'string') {
    const key = value.trim().toLowerCase();
    return s.enum.find((m) => typeof m === 'string' && m.toLowerCase() === key) ?? value;
  }
  if (s.type === 'array' && Array.isArray(value)) return value.map((v) => foldEnumCase(v, s.items));
  if (s.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (s.properties ?? {}) as Json;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k in props ? foldEnumCase(v, props[k]) : v]));
  }
  return value;
}
