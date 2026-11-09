/**
 * What a request carries (spec §3.6) and which records a job reads (§3.10).
 */
import { describe, expect, it } from 'vitest';
import { segment, type Candidate } from '@/data';
import { gloamwoodEntries, gloamwoodRecords } from '@/test/structuredFixtures';
import type { CompendiumEntry, StructuredRecord } from '@/types';
import { jobRecords, missesOf, planRequest, requestBlocks } from './blocks';

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

  it('takes a selection, a row standing for its table', () => {
    const picked = jobRecords(records, { claudeFor: 'selection', recordIds: [byName('Hookstaff').id, byName('Mothkin').id] });
    expect(picked.map((r) => r.name)).toEqual(['Mothkin', 'Gloamwood Arms']);
  });
});
