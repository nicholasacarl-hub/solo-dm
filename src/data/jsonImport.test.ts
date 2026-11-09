import { describe, expect, it } from 'vitest';
import { gloamwoodEntries, gloamwoodSource } from '@/test/structuredFixtures';
import { parseJsonImport, routeJsonImport } from './jsonImport';
import { exportPack } from './structured/packs';

const opts = { sourceId: 'import-json', sourceName: 'Shared Pack' };

describe('parseJsonImport', () => {
  it('accepts a list of entries and re-homes them in the new source', () => {
    const entries = parseJsonImport(
      JSON.stringify([
        { id: 'srd:spell:old', sourceId: 'elsewhere', sourceName: 'Old', kind: 'spell', name: 'Frost Lance', summary: 'Level 2 Evocation', text: 'A lance of ice.', data: { level: 2 } },
        { name: 'Table Rule', text: 'Roll twice.', path: ['House Rules', 'Table Rule'] },
      ]),
      opts,
    );
    expect(entries).toEqual([
      {
        id: 'lib:import-json:1',
        sourceId: 'import-json',
        sourceName: 'Shared Pack',
        kind: 'spell',
        name: 'Frost Lance',
        summary: 'Level 2 Evocation',
        text: 'A lance of ice.',
        data: { level: 2 },
      },
      {
        id: 'lib:import-json:2',
        sourceId: 'import-json',
        sourceName: 'Shared Pack',
        kind: 'rule',
        name: 'Table Rule',
        text: 'Roll twice.',
        path: ['House Rules', 'Table Rule'],
      },
    ]);
  });

  it('accepts { entries: [...] } and already-parsed values', () => {
    const entries = parseJsonImport({ source: { title: 'x' }, entries: [{ kind: 'monster', name: 'Mud Imp', text: 'A small imp.' }] }, opts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'monster', name: 'Mud Imp' });
  });

  it('guesses a missing kind and maps an unknown kind to "other"', () => {
    const [guessed, unknown] = parseJsonImport(
      [
        { name: 'Glimmer', text: '_Level 1 Illusion (Wizard)_\n\n- **Casting Time:** Action' },
        { kind: 'vehicle', name: 'Airship', text: 'It flies.' },
      ],
      opts,
    );
    expect(guessed.kind).toBe('spell');
    expect(unknown.kind).toBe('other');
  });

  it('drops unknown fields', () => {
    const [entry] = parseJsonImport([{ name: 'X', text: 'Y', campaignId: 'c1', secret: true }], opts);
    expect(entry).not.toHaveProperty('campaignId');
    expect(entry).not.toHaveProperty('secret');
  });

  it('explains invalid JSON', () => {
    expect(() => parseJsonImport('{ not json', opts)).toThrow(/isn't valid JSON/);
  });

  it('explains an unexpected shape', () => {
    expect(() => parseJsonImport('{"title": "nothing here"}', opts)).toThrow(/expected a list of entries/);
    expect(() => parseJsonImport('[]', opts)).toThrow(/no entries/);
  });

  it('reports which entries are invalid, and why', () => {
    const run = () =>
      parseJsonImport(
        [{ name: 'Good', text: 'ok' }, { name: '', text: 'no name' }, { name: 'No Text' }, { name: 'Bad Path', text: 'x', path: 'A > B' }],
        opts,
      );
    expect(run).toThrow(/Entry 2: name: needs a name/);
    expect(run).toThrow(/Entry 3 \("No Text"\): text: needs text/);
    expect(run).toThrow(/Entry 4 \("Bad Path"\): path:/);
  });
});

describe('routeJsonImport', () => {
  it('sends a "solo-dm-pack" file to the pack reader and anything else to the entry reader', () => {
    const pack = routeJsonImport(JSON.stringify(exportPack(gloamwoodSource(), gloamwoodEntries(), [])), opts);
    expect(pack.type).toBe('pack');
    expect(pack.type === 'pack' && pack.pack.entries[0].id).toBe('lib:import-json:1');
    const plain = routeJsonImport(JSON.stringify([{ name: 'Rule', text: 'Text.' }]), opts);
    expect(plain).toEqual({ type: 'entries', entries: parseJsonImport([{ name: 'Rule', text: 'Text.' }], opts) });
    expect(() => routeJsonImport('{nope', opts)).toThrow(/valid JSON/);
  });
});
