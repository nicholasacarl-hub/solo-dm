import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { EXPECTED_DATA, gloamwoodRecords } from '@/test/structuredFixtures';
import type { StructuredDataByKind, StructuredRecord } from '@/types';
import { DATA_SCHEMAS, RECORD_SCHEMA, TEXT_SPAN } from './schemas';

type Data<K extends keyof StructuredDataByKind> = z.infer<(typeof DATA_SCHEMAS)[K]>;
/** ItemData is an Omit<…> & {…} intersection; expectTypeOf compares the flattened form. */
type Flat<T> = { [K in keyof T]: T[K] };

describe('DATA_SCHEMAS', () => {
  it('mirror src/types/structured.ts field for field (checked by tsc)', () => {
    expectTypeOf<Data<'monster'>>().toEqualTypeOf<StructuredDataByKind['monster']>();
    expectTypeOf<Data<'spell'>>().toEqualTypeOf<StructuredDataByKind['spell']>();
    expectTypeOf<Data<'magic-item'>>().toEqualTypeOf<StructuredDataByKind['magic-item']>();
    expectTypeOf<Data<'item'>>().toEqualTypeOf<Flat<StructuredDataByKind['item']>>();
    expectTypeOf<Data<'feat'>>().toEqualTypeOf<StructuredDataByKind['feat']>();
    expectTypeOf<Data<'species'>>().toEqualTypeOf<StructuredDataByKind['species']>();
    expectTypeOf<Data<'background'>>().toEqualTypeOf<StructuredDataByKind['background']>();
    expectTypeOf<Data<'class'>>().toEqualTypeOf<StructuredDataByKind['class']>();
    expectTypeOf<Data<'subclass'>>().toEqualTypeOf<StructuredDataByKind['subclass']>();
    expectTypeOf<z.infer<typeof RECORD_SCHEMA>>().toEqualTypeOf<StructuredRecord>();
  });

  it('accept the fixture book', () => {
    expect(DATA_SCHEMAS.monster.safeParse(EXPECTED_DATA['Glimmerwing Drake']).success).toBe(true);
    expect(DATA_SCHEMAS.class.safeParse(EXPECTED_DATA.Wickwright).success).toBe(true);
  });

  it('reject unknown keys, a JSON __proto__ own property included', () => {
    expect(DATA_SCHEMAS.feat.safeParse({ ...EXPECTED_DATA['Lantern Bearer'], extra: 1 }).success).toBe(false);
    const polluted = JSON.parse(`{"__proto__": {"admin": true}, ${JSON.stringify(EXPECTED_DATA["Moth's Grace"]).slice(1)}`) as unknown;
    expect(DATA_SCHEMAS.feat.safeParse(polluted).success).toBe(false);
  });

  it('enforce the DM tool limits and integrality', () => {
    const drake = EXPECTED_DATA['Glimmerwing Drake'];
    for (const bad of [{ ac: 41 }, { ac: 0 }, { hp: 2001 }, { initiative: 21 }, { reachFt: 7 }, { reachFt: 65 }, { hp: 52.5 }, { cr: '31' }, { crValue: 2 }]) {
      expect(DATA_SCHEMAS.monster.safeParse({ ...drake, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(DATA_SCHEMAS.monster.safeParse({ ...drake, abilities: { ...drake.abilities, str: 31 } }).success).toBe(false);
  });

  it('enforce class and background shapes: hit die, two saves, 20 level rows, three or no abilities', () => {
    const cls = EXPECTED_DATA.Wickwright;
    expect(DATA_SCHEMAS.class.safeParse({ ...cls, hitDie: 7 }).success).toBe(false);
    expect(DATA_SCHEMAS.class.safeParse({ ...cls, savingThrows: ['int'] }).success).toBe(false);
    expect(DATA_SCHEMAS.class.safeParse({ ...cls, levelTable: cls.levelTable.slice(0, 19) }).success).toBe(false);
    expect(DATA_SCHEMAS.class.safeParse({ ...cls, subclassLevel: 4 }).success).toBe(false);
    expect(DATA_SCHEMAS.background.safeParse({ ...EXPECTED_DATA.Lamplighter, abilityScores: ['dex', 'wis'] }).success).toBe(false);
    expect(DATA_SCHEMAS.subclass.safeParse({ ...EXPECTED_DATA['Ember Warden'], summary: 'x'.repeat(201) }).success).toBe(false);
  });

  it('check text spans: at least one entry, 1-based, from ≤ to', () => {
    expect(TEXT_SPAN.safeParse({ entryIds: ['lib:s:1'], from: 1, to: 2 }).success).toBe(true);
    expect(TEXT_SPAN.safeParse({ entryIds: [], from: 1, to: 1 }).success).toBe(false);
    expect(TEXT_SPAN.safeParse({ entryIds: ['lib:s:1'], from: 0, to: 1 }).success).toBe(false);
    expect(TEXT_SPAN.safeParse({ entryIds: ['lib:s:1'], from: 3, to: 2 }).success).toBe(false);
  });
});

describe('RECORD_SCHEMA', () => {
  const [record] = gloamwoodRecords().filter((r) => r.name === 'Glimmerwing Drake');

  it('reads a stored record, validating its data with its kind', () => {
    expect(RECORD_SCHEMA.safeParse(record).success).toBe(true);
    expect(RECORD_SCHEMA.safeParse({ ...record, data: { ...record.data, ac: 99 } }).success).toBe(false);
    expect(RECORD_SCHEMA.safeParse({ ...record, kind: 'spell' }).success).toBe(false);
    expect(RECORD_SCHEMA.safeParse({ ...record, data: null }).success).toBe(true);
  });

  it('strips unknown envelope keys (newer versions stay readable) but limits records to 64 KB', () => {
    const newer = RECORD_SCHEMA.safeParse({ ...record, schemaVersion: 2, futureField: true });
    expect(newer.success).toBe(true);
    expect(newer.data).not.toHaveProperty('futureField');
    expect(RECORD_SCHEMA.safeParse({ ...record, excerpts: Array.from({ length: 40 }, () => ({ field: 'x', text: 'y'.repeat(2000), grounded: true })) }).success).toBe(false);
  });
});
