/**
 * What a request carries (spec §3.6) and which records a job reads (§3.10).
 */
import { describe, expect, it } from 'vitest';
import { chunkDocument } from '@/data/chunk';
import { segment, type Candidate, type Reading } from '@/data';
import type { Wire } from '@/data/structured/wire';
import { GLOAMWOOD_TITLE, gloamwoodEntries, gloamwoodRecords } from '@/test/structuredFixtures';
import type { CompendiumEntry, StructuredRecord } from '@/types';
import { buildExtractionRequest } from '../libraryRequests';
import { cutWarning, jobRecords, missesOf, planRequest, requestBlocks, requestPath, withCutWarning, withDroppedBlocks } from './blocks';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const { candidates } = segment(gloamwoodEntries(), CTX);
const candidate = (name: string) => candidates.find((c) => c.name === name) as Candidate;

describe('requestBlocks', () => {
  it('sends an entity’s block whole, its paragraph numbering intact', () => {
    const drake = candidate('Glimmerwing Drake');
    const { blocks, cut } = requestBlocks(drake);
    expect(cut).toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: 'B1', title: 'Glimmerwing Drake', abbreviated: false });
    expect(blocks[0].paragraphs).toHaveLength(drake.blocks[0].paragraphs.length);
  });

  it('shows a table’s header above its first row (the columns), without renumbering', () => {
    const { blocks } = requestBlocks(candidate('Glimmerwing Drake'));
    const scores = blocks[0].paragraphs.find((p) => p.includes('**Score**'))!;
    expect(scores.split('\n')[0]).toContain('Str.');
    const wickwright = requestBlocks(candidate('Wickwright')).blocks.find((b) => b.title === 'Wickwright Class Features')!;
    expect(wickwright.paragraphs[1]).toMatch(/^\| Level \| Proficiency Bonus \|/);
    expect(wickwright.paragraphs).toHaveLength(21);
  });

  it('abbreviates long feature blocks of a section, never its first block or blocks about core traits, spells or tables', () => {
    const long = 'A long feature paragraph that goes on and on about the way a lamp is trimmed and lit at dusk on the roads. '.repeat(3);
    const entries: CompendiumEntry[] = [
      { id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'rule', name: 'Fighter Subclass: Lamp Knight', text: `${long}\n\n${long}`, path: ['Options', 'Fighter Subclass: Lamp Knight'] },
      { id: 'lib:t:2', sourceId: 't', sourceName: 'T', kind: 'rule', name: 'Level 3: Trim', text: `${long}\n\n${long}`, path: ['Options', 'Fighter Subclass: Lamp Knight', 'Level 3: Trim'] },
      { id: 'lib:t:3', sourceId: 't', sourceName: 'T', kind: 'rule', name: 'Level 3: Knight Spells', text: `${long}\n\n${long}`, path: ['Options', 'Fighter Subclass: Lamp Knight', 'Level 3: Knight Spells'] },
    ];
    const [knight] = segment(entries, CTX).candidates;
    const { blocks } = requestBlocks(knight);
    expect(blocks.map((b) => b.abbreviated)).toEqual([false, true, false]);
    expect(blocks[1].paragraphs).toHaveLength(2);
    expect(blocks[1].paragraphs[0].length).toBeLessThanOrEqual(101);
    expect(blocks[1].paragraphs[0].endsWith('…')).toBe(true);
  });

  it('caps an entity request at 16,000 characters', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${'x'.repeat(600)}`).join('\n\n');
    const spell: CompendiumEntry = { id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'spell', name: 'Long Spell', text, path: ['Spells', 'Long Spell'] };
    const [c] = segment([spell], CTX).candidates;
    const r = requestBlocks(c);
    expect(r.cut).toBe(true);
    expect(r.chars).toBeLessThanOrEqual(16_000);
    expect(planRequest(c)).toMatchObject({ kind: 'spell', blocks: 1, chars: r.chars, rows: 0 });
  });

  it('X4: sends no document title in a block path, whatever the Library calls the book', () => {
    // An invented book whose first heading is its title; the Library title is the file-name default.
    const book = [
      '# The Lantern Codex',
      'Notes gathered on the lamp roads.',
      '## Spells',
      '### Ember Lash',
      '_Level 1 Evocation (Wizard)_',
      '- **Casting Time:** Action\n- **Range:** 30 feet\n- **Components:** V, S\n- **Duration:** Instantaneous',
      'A whip of embers strikes one creature you can see within range. It makes a Dexterity saving throw, taking 2d6 Fire damage on a failed save or half as much on a successful one.',
    ].join('\n\n');
    const entries = chunkDocument(book, { sourceId: 'lc', sourceName: 'lantern codex' });
    const lash = segment(entries, CTX).candidates.find((c) => c.name === 'Ember Lash') as Candidate;
    expect(lash.blocks[0].path).toEqual(['The Lantern Codex', 'Spells', 'Ember Lash']);
    const { blocks } = requestBlocks(lash);
    expect(blocks[0].path).toEqual(['Spells', 'Ember Lash']);
    const body = JSON.stringify(buildExtractionRequest({ kind: 'spell', model: 'claude-opus-5-5', useFallbacks: false, blocks }));
    expect(body).not.toContain('The Lantern Codex');
    expect(body).toContain('Spells › Ember Lash');
    // Every candidate of the fixture book: neither its title nor a top-level chapter heading goes out.
    for (const c of candidates) {
      for (const b of requestBlocks(c).blocks) expect(b.path.join(' › '), c.name).not.toMatch(new RegExp(`${GLOAMWOOD_TITLE}|Peoples of the Gloamwood`));
    }
  });

  it('X4: keeps a section’s nesting and its chapter, never the top level (a heading made from a file name included)', () => {
    expect(requestPath(['lantern-codex-ch2', 'Bestiary', 'Glimmerwing Drake'], 2)).toEqual(['Bestiary', 'Glimmerwing Drake']);
    expect(requestPath(['lantern-codex-ch2', 'Glimmerwing Drake'], 1)).toEqual(['Glimmerwing Drake']);
    expect(requestPath(['Book', 'Part 1', 'Classes', 'Lamplighter', 'Level 1: Wick'], 3)).toEqual(['Classes', 'Lamplighter', 'Level 1: Wick']);
    // A candidate that is itself a top-level heading keeps it (its name is the first block's title anyway).
    expect(requestPath(['Lamplighter', 'Level 1: Wick'], 0)).toEqual(['Lamplighter', 'Level 1: Wick']);
    expect(requestPath(['Owlbear Den'], 0)).toEqual(['Owlbear Den']);
  });

  it('X8: names the blocks a section request leaves out, and takes their features from the offline heading scan', () => {
    const intro = 'Knights of the lamp keep watch where the spells of the old roads still linger, and they learn a few of those spells.';
    const feature = () => `Each night the knight trims the lamp and studies the spells of the road, gaining a new rite at this level. ${'The rite is long in the telling. '.repeat(400)}`;
    const levels = [3, 3, 7, 10, 15, 18];
    const book = ['# Options', '## Fighter Subclass: Lamp Knight', intro, ...levels.flatMap((lvl, i) => [`### Level ${lvl}: Rite ${i + 1}`, feature()])].join('\n\n');
    const knight = segment(chunkDocument(book, { sourceId: 'lk', sourceName: 'Lamp Book' }), CTX).candidates[0];
    expect(knight.kind).toBe('subclass');
    const plan = requestBlocks(knight);
    expect(plan.cut).toBe(true);
    expect(plan.chars).toBeLessThanOrEqual(60_000);
    expect(plan.dropped.length).toBeGreaterThan(0);
    expect(plan.blocks.map((b) => b.id)).not.toContain(plan.dropped[0]);
    const sent = new Set(plan.blocks.map((b) => b.id));
    const claude: Wire<'subclass'> = {
      matchesKind: true, name: 'Lamp Knight', format: '2024', parentClassText: 'Fighter', taglineText: '',
      features: knight.blocks.filter((b) => sent.has(b.id) && /^Level/.test(b.title)).map((b) => ({ level: Number(/Level (\d+)/.exec(b.title)![1]), name: b.title.replace(/^Level \d+: /, ''), text: { block: b.id, from: 1, to: b.paragraphs.length } })),
      casterType: 'none', spellcastingAbility: 'none', alwaysPreparedSpells: [], notes: '',
    };
    const filled = withDroppedBlocks(knight, claude, plan.dropped) as Wire<'subclass'>;
    expect(filled.features.map((f) => f.name)).toEqual(levels.map((_, i) => `Rite ${i + 1}`));
    expect(filled.features.at(-1)).toMatchObject({ level: 18, text: { block: plan.dropped.at(-1) } });
    // Nothing dropped: Claude's reading as it is.
    expect(withDroppedBlocks(knight, claude, [])).toBe(claude);
  });

  it('X8: a reading of a cut request gets a warn, which makes a confident one medium', () => {
    const reading = (confidence: 'high' | 'medium' | 'low') => ({ normalized: { confidence, warnings: [] } }) as unknown as Reading;
    const [high, medium, low] = withCutWarning([reading('high'), reading('medium'), reading('low')], 'spell');
    expect(high.normalized).toMatchObject({ confidence: 'medium', warnings: [cutWarning('spell')] });
    expect(medium.normalized.confidence).toBe('medium');
    expect(low.normalized.confidence).toBe('low');
    expect(cutWarning('spell')).toMatchObject({ code: 'missing', severity: 'warn' });
    expect(cutWarning('class').message).toMatch(/section/);
  });

  it('sends only a long gear table’s own rows, with the header', () => {
    const rows = Array.from({ length: 70 }, (_, i) => `| Blade ${i + 1} | 1d6 Slashing | Light | Nick | 2 lb. | 5 GP |`);
    const text = ['Blades of the roads.', '| Martial Melee Weapons | Damage | Properties | Mastery | Weight | Cost |', '|---|---|---|---|---|---|', ...rows].join('\n');
    const [, second] = segment([{ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'rule', name: 'Blades', text, path: ['Equipment', 'Blades'] }], CTX).candidates;
    const { blocks } = requestBlocks(second);
    expect(blocks[0].paragraphs[0]).toBe('Blades of the roads.');
    expect(blocks[0].paragraphs[1].split('\n')[2]).toContain('Blade 61');
    expect(blocks[0].paragraphs).toHaveLength(11);
    expect(planRequest(second).rows).toBe(10);
  });
});

describe('jobRecords', () => {
  const records = gloamwoodRecords();
  const byName = (name: string) => records.find((r) => r.name === name) as StructuredRecord;

  it('takes the misses: no data, not kept as text, not a gear table whose rows exist', () => {
    const unread = records.map((r) => (r.name === 'Mothkin' ? { ...r, data: null } : r));
    expect(missesOf(unread).map((r) => r.name)).toEqual(['Mothkin', 'Goblin Warrior']);
    const rejected = unread.map((r) => (r.name === 'Goblin Warrior' ? { ...r, status: 'rejected' as const } : r));
    expect(jobRecords(rejected, { claudeFor: 'misses' }).map((r) => r.name)).toEqual(['Mothkin']);
  });

  it('takes everything not kept as text (no rows: their table is read), limited to kinds', () => {
    const all = jobRecords(records, { claudeFor: 'all', kinds: ['item'] });
    expect(all.map((r) => r.name)).toEqual(['Gloamwood Arms', 'Wick Lantern']);
  });

  it('X3: "all" re-reads only this device’s readings and the misses, never Claude’s, a pack’s or hand-filled ones', () => {
    const mixed = records.map((r) =>
      r.name === 'Mothkin' ? { ...r, origin: 'pack' as const } : r.name === 'Lamplighter' ? { ...r, origin: 'manual' as const } : r.name === 'Cinder Mote' ? { ...r, status: 'rejected' as const } : r,
    );
    const names = jobRecords(mixed, { claudeFor: 'all' }).map((r) => r.name);
    // Dusk Domain was read by Claude (paid for); Mothkin came from a pack; Lamplighter was filled in by hand; Cinder Mote is kept as text.
    for (const name of ['Dusk Domain', 'Mothkin', 'Lamplighter', 'Cinder Mote']) expect(names, name).not.toContain(name);
    expect(names).toContain('Goblin Warrior'); // a miss
    expect(names).toContain('Gloamwood Arms'); // its rows were read here
    const expected = mixed.filter((r) => r.span !== 'row' && r.status !== 'rejected' && r.origin === 'parser').map((r) => r.name);
    expect(names).toEqual(expected);
    // A selection still reaches any of them.
    expect(jobRecords(mixed, { claudeFor: 'selection', recordIds: [byName('Dusk Domain').id, byName('Mothkin').id] }).map((r) => r.name)).toEqual(['Mothkin', 'Dusk Domain']);
  });

  it('takes a selection, a row standing for its table', () => {
    const picked = jobRecords(records, { claudeFor: 'selection', recordIds: [byName('Hookstaff').id, byName('Mothkin').id] });
    expect(picked.map((r) => r.name)).toEqual(['Mothkin', 'Gloamwood Arms']);
  });
});
