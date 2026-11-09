import { describe, expect, it } from 'vitest';
import type { CompendiumEntry, HomebrewEntry } from '@/types';
import { createRulesIndex, makeSnippet, processTerm, sourcePriority } from './search';

const srd = (kind: CompendiumEntry['kind'], name: string, text: string, extra: Partial<CompendiumEntry> = {}): CompendiumEntry => ({
  id: `srd:${kind}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  sourceId: 'srd-5.2.1',
  sourceName: 'SRD 5.2.1',
  kind,
  name,
  text,
  ...extra,
});

const lib = (n: number, kind: CompendiumEntry['kind'], name: string, text: string): CompendiumEntry => ({
  id: `lib:import-phb:${n}`,
  sourceId: 'import-phb',
  sourceName: 'My PHB notes',
  kind,
  name,
  text,
});

const homebrew = (id: string, name: string, campaignId: string | null, extra: Partial<HomebrewEntry> = {}): HomebrewEntry => ({
  id,
  sourceId: 'homebrew',
  sourceName: 'Homebrew',
  kind: 'spell',
  name,
  text: `A homebrew version of ${name}.`,
  campaignId,
  origin: 'dm',
  status: 'active',
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

const FIXTURE: CompendiumEntry[] = [
  srd('spell', 'Fireball', 'A bright streak flashes from you and blossoms into a fiery explosion. Each creature takes 8d6 Fire damage.', {
    summary: 'Level 3 Evocation · Sorcerer, Wizard',
  }),
  srd('spell', 'Fire Bolt', 'You hurl a mote of fire at a creature or object within range.', { summary: 'Evocation cantrip · Sorcerer, Wizard' }),
  srd('magic-item', 'Necklace of Fireballs', 'This necklace has beads. You can throw a bead to cast Fireball.', {
    summary: 'Wondrous Item, rare',
  }),
  srd('monster', 'Fire Elemental', 'A roaring column of flame. Touch: Fire damage.', { summary: 'CR 5 (1,800 XP) · Large Elemental' }),
  srd('rule', 'Spell Slots', 'Casting a spell like Fireball expends a slot of that level or higher.', { path: ['Spells', 'Spell Slots'] }),
  srd('rule', 'Initiative', 'Initiative determines the order of turns during combat.', { path: ['Rules Glossary', 'Initiative'] }),
  srd('rule', 'Initiative', 'Every participant rolls Initiative when combat starts.', {
    id: 'srd:rule:combat-initiative',
    path: ['Playing the Game', 'Combat', 'The Order of Combat', 'Initiative'],
  }),
  srd('item', 'Shield', 'A Shield gives +2 AC.', { summary: 'Shield · +2 AC' }),
  srd('spell', 'Shield', 'An imperceptible barrier of magical force protects you. +5 bonus to AC.'),
  srd('item', 'Arcane Focus', 'An Arcane Focus channels arcane magic.'),
  srd('item', "Clothes, Traveler's", 'Resilient garments designed for travel.'),
  srd('magic-item', 'Stone of Good Luck (Luckstone)', 'While this polished agate is on your person, you gain a +1 bonus.'),
  srd('condition', 'Grappled', 'Your Speed is 0 and can\'t increase.'),
  lib(1, 'spell', 'Fireball', 'My notes on Fireball: it is loud.'),
  lib(2, 'rule', 'Flanking', 'Optional rule: allies on opposite sides grant Advantage.'),
  homebrew('hb:shared', 'Fireball', null),
  homebrew('hb:camp-1', 'Fireball', 'camp-1'),
  homebrew('hb:camp-2', 'Glacier Spike', 'camp-2'),
  homebrew('hb:retired', 'Old Lightning', null, { status: 'retired' }),
];

const index = createRulesIndex(FIXTURE);

describe('rules index search', () => {
  it('ranks the exact name above entries that only mention it', () => {
    const hits = index.search('fireball', { sourceIds: ['srd-5.2.1'] });
    expect(hits[0].entry.id).toBe('srd:spell:fireball');
    expect(hits.map((h) => h.entry.name)).toEqual(expect.arrayContaining(['Necklace of Fireballs', 'Spell Slots']));
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
  });

  it('matches prefixes and typos', () => {
    expect(index.search('firebal', { sourceIds: ['srd-5.2.1'] })[0].entry.name).toBe('Fireball');
    expect(index.search('fierball', { sourceIds: ['srd-5.2.1'] })[0].entry.name).toBe('Fireball');
    expect(index.search('elemen')[0].entry.name).toBe('Fire Elemental');
  });

  it('filters by kind', () => {
    const hits = index.search('fire', { kinds: ['monster'] });
    expect(hits.map((h) => h.entry.name)).toEqual(['Fire Elemental']);
    expect(index.search('fire', { kinds: ['spell', 'magic-item'] }).every((h) => ['spell', 'magic-item'].includes(h.entry.kind))).toBe(true);
  });

  it('filters by source', () => {
    const hits = index.search('fireball', { sourceIds: ['import-phb'] });
    expect(hits.map((h) => h.entry.id)).toEqual(['lib:import-phb:1']);
  });

  it('shows shared homebrew by default and campaign homebrew only for its campaign', () => {
    const ids = (campaignId?: string | null) => index.search('fireball glacier lightning', { campaignId }).map((h) => h.entry.id);
    expect(ids()).toContain('hb:shared');
    expect(ids()).not.toContain('hb:camp-1');
    expect(ids('camp-1')).toEqual(expect.arrayContaining(['hb:shared', 'hb:camp-1']));
    expect(ids('camp-1')).not.toContain('hb:camp-2');
    expect(ids('camp-2')).toContain('hb:camp-2');
    for (const c of [undefined, 'camp-1', 'camp-2']) expect(ids(c)).not.toContain('hb:retired');
  });

  it('respects the limit and ignores empty queries', () => {
    expect(index.search('fire', { limit: 2 })).toHaveLength(2);
    expect(index.search('   ')).toEqual([]);
    expect(index.search('the of and')).toEqual([]);
  });

  it('returns a snippet around the match', () => {
    const [hit] = index.search('blossoms', { kinds: ['spell'] });
    expect(hit.entry.name).toBe('Fireball');
    expect(hit.snippet).toContain('blossoms');
  });
});

describe('rules index lookups', () => {
  it('finds names case- and punctuation-insensitively, preferring homebrew > reviewed imports > SRD > unreviewed imports', () => {
    expect(index.findByName('FIREBALL', { campaignId: 'camp-1' })?.id).toBe('hb:camp-1');
    expect(index.findByName('fireball')?.id).toBe('hb:shared');
    expect(index.findByName('Fire-Ball', { campaignId: 'camp-2' })?.id).toBe('hb:shared');
    const withoutHomebrew = FIXTURE.filter((e) => e.sourceId !== 'homebrew');
    // An unreviewed imported spell (the chunker's guess) no longer shadows the SRD's (spec §6.2)…
    expect(createRulesIndex(withoutHomebrew).findByName('Fireball')?.id).toBe('srd:spell:fireball');
    // …a reviewed one does.
    const reviewed = withoutHomebrew.map((e) => (e.id === 'lib:import-phb:1' ? { ...e, data: { recordId: 'rec:import-phb:spell:fireball', level: 3 } } : e));
    expect(createRulesIndex(reviewed).findByName('Fireball')?.id).toBe('lib:import-phb:1');
    expect(createRulesIndex(FIXTURE.filter((e) => e.sourceId === 'srd-5.2.1')).findByName("fire ball!")?.id).toBe('srd:spell:fireball');
  });

  it('honours the kind option and breaks ties by kind and path depth', () => {
    expect(index.findByName('Shield')?.kind).toBe('spell');
    expect(index.findByName('shield', { kind: 'item' })?.id).toBe('srd:item:shield');
    expect(index.findByName('Initiative')?.id).toBe('srd:rule:initiative');
    expect(index.findByName('Grappled', { kind: 'spell' })).toBeUndefined();
  });

  it('matches plurals, parenthetical aliases and inverted names', () => {
    expect(index.findByName('Fire Bolts')?.name).toBe('Fire Bolt');
    expect(index.findByName('Luckstone')?.name).toBe('Stone of Good Luck (Luckstone)');
    expect(index.findByName('Stone of Good Luck')?.name).toBe('Stone of Good Luck (Luckstone)');
    expect(index.findByName("Traveler's Clothes")?.name).toBe("Clothes, Traveler's");
  });

  it('never returns retired or other campaigns\' homebrew by name', () => {
    expect(index.findByName('Old Lightning')).toBeUndefined();
    expect(index.findByName('Glacier Spike')).toBeUndefined();
    expect(index.findByName('Glacier Spike', { campaignId: 'camp-2' })?.id).toBe('hb:camp-2');
  });

  it('gets entries by id, resolving variant ids to their base entry', () => {
    expect(index.get('srd:spell:fire-bolt')?.name).toBe('Fire Bolt');
    expect(index.get('srd:item:arcane-focus:crystal')?.name).toBe('Arcane Focus');
    expect(index.get('srd:item:nothing')).toBeUndefined();
  });

  it('lists entries by kind and source, and counts sources', () => {
    expect(index.list({ kind: 'condition' }).map((e) => e.name)).toEqual(['Grappled']);
    expect(index.list({ sourceId: 'import-phb' })).toHaveLength(2);
    expect(index.list({ sourceId: 'homebrew' }).map((e) => e.id)).toEqual(['hb:shared', 'hb:camp-1', 'hb:camp-2']);
    expect(index.sources()).toEqual([
      { id: 'srd-5.2.1', name: 'SRD 5.2.1', count: 13 },
      { id: 'import-phb', name: 'My PHB notes', count: 2 },
      { id: 'homebrew', name: 'Homebrew', count: 3 },
    ]);
  });

  it('keeps the first entry when ids repeat', () => {
    const dup = createRulesIndex([FIXTURE[0], { ...FIXTURE[0], name: 'Duplicate' }]);
    expect(dup.list()).toHaveLength(1);
    expect(dup.get(FIXTURE[0].id)?.name).toBe('Fireball');
  });
});

describe('structured imports in the index (spec §6.1, §6.2)', () => {
  const reviewedOf = (e: CompendiumEntry, data: Record<string, unknown> = {}): CompendiumEntry => ({ ...e, data: { ...e.data, ...data, recordId: `rec:${e.id}` } });
  const goblin = srd('monster', 'Goblin Warrior', 'A goblin.', { data: { size: 'Small', ac: 15 } });
  const thin = { ...lib(3, 'monster', 'Goblin Warrior', 'A goblin of the book.'), data: { cr: '1/4' } };

  it('ranks by the §6.2 table', () => {
    expect(sourcePriority(homebrew('hb:c', 'X', 'camp-1'))).toBe(0);
    expect(sourcePriority(homebrew('hb:s', 'X', null))).toBe(1);
    expect(sourcePriority(reviewedOf(thin))).toBe(2);
    for (const kind of ['rule', 'condition', 'boon', 'other'] as const) expect(sourcePriority(lib(4, kind, 'X', 'x'))).toBe(2);
    expect(sourcePriority(goblin)).toBe(3);
    for (const kind of ['monster', 'spell', 'magic-item', 'item', 'feat', 'class', 'subclass', 'species', 'background'] as const) {
      expect(sourcePriority(lib(5, kind, 'X', 'x'))).toBe(4);
    }
  });

  it('keeps the SRD stat block over an unreviewed duplicate, and takes a reviewed one over the SRD', () => {
    expect(createRulesIndex([goblin, thin]).findByName('Goblin Warrior', { kind: 'monster' })?.id).toBe(goblin.id);
    expect(createRulesIndex([goblin, reviewedOf(thin)]).findByName('Goblin Warrior', { kind: 'monster' })?.id).toBe(thin.id);
    // A book's own rules section still answers before the SRD's.
    const rule = lib(6, 'rule', 'Initiative', 'House initiative.');
    expect(createRulesIndex([...FIXTURE.filter((e) => e.sourceId === 'srd-5.2.1'), rule]).findByName('Initiative')?.id).toBe(rule.id);
  });

  it('resolves the chunk ids a materialized entry replaced, without listing or searching them', () => {
    const merged: CompendiumEntry = {
      ...lib(7, 'species', 'Mothkin', 'Soft-winged folk.'),
      id: 'lib:import-phb:species:mothkin',
      data: { recordId: 'rec:import-phb:species:mothkin', aliasIds: ['lib:import-phb:8', 'lib:import-phb:9', 'srd:spell:fireball'] },
    };
    const idx = createRulesIndex([...FIXTURE, merged]);
    expect(idx.get('lib:import-phb:8')?.id).toBe(merged.id);
    expect(idx.get('lib:import-phb:9')?.id).toBe(merged.id);
    // An alias never takes over an id an entry owns.
    expect(idx.get('srd:spell:fireball')?.name).toBe('Fireball');
    expect(idx.list({ sourceId: 'import-phb' }).map((e) => e.id)).not.toContain('lib:import-phb:8');
    expect(idx.search('mothkin').map((h) => h.entry.id)).toEqual([merged.id]);
    // Four-segment ids never pop down to a wrong three-segment entry.
    expect(idx.get('lib:import-phb:species:unknown')).toBeUndefined();
  });

  it('keeps the materialized entry over a raw chunk with the same id (first wins)', () => {
    const raw = lib(1, 'monster', 'Glimmerwing Drake', 'raw');
    const reviewed = reviewedOf({ ...raw, text: 'reviewed' }, { size: 'Large' });
    expect(createRulesIndex([reviewed, raw]).get(raw.id)?.text).toBe('reviewed');
  });
});

describe('makeSnippet', () => {
  const long = `${'Intro words that set the scene. '.repeat(20)}The grappler can drag you when it moves. ${'More trailing text follows here. '.repeat(20)}`;

  it('centres about 240 characters on the first matched term', () => {
    const snippet = makeSnippet(long, ['grappler']);
    expect(snippet).toContain('grappler can drag you');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(245);
  });

  it('strips Markdown and falls back to the start without a match', () => {
    expect(makeSnippet('_**Speed 0.**_ Your Speed is 0.', ['speed'])).toBe('Speed 0. Your Speed is 0.');
    expect(makeSnippet(long, ['absent']).startsWith('Intro words')).toBe(true);
  });
});

describe('processTerm', () => {
  it('lowercases, trims punctuation and drops stop words and single letters', () => {
    expect(processTerm('Fireball,')).toBe('fireball');
    expect(processTerm('The')).toBeNull();
    expect(processTerm('s')).toBeNull();
    expect(processTerm('1d6')).toBe('1d6');
  });
});
