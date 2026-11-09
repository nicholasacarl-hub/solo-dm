import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import { createRulesIndex } from '@/data/search';
import { materializeEntries } from '@/data/structured/materialize';
import { redactImported } from '@/lib/importedContent';
import { gloamwoodEntries, gloamwoodRecords, gloamwoodSource, GLOAMWOOD_TITLE } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { deps, resetDmDeps, setDmDeps } from '../deps';
import { setupHarness } from '../testing/harness';
import type { ToolContext } from './context';
import { runTool } from './handlers';
import { findAllowedEntry, RULES_HIT_LIMIT, RULES_OUTPUT_LIMIT } from './rules';

afterEach(() => resetDmDeps());

const SRD_GOBLIN: CompendiumEntry = {
  id: 'srd:monster:goblin-warrior',
  sourceId: 'srd-5.2.1',
  sourceName: 'SRD 5.2.1',
  kind: 'monster',
  name: 'Goblin Warrior',
  summary: 'CR 1/4 (50 XP) · Small Fey',
  text: 'A goblin of the SRD.',
  data: { size: 'Small', ac: 15, hp: 10, initiative: 2 },
};
const NOTES_WARDEN: CompendiumEntry = {
  id: 'lib:notes:1',
  sourceId: 'notes',
  sourceName: 'Gloamwood Notes',
  kind: 'subclass',
  name: 'Ember Warden',
  text: 'My own notes on the Ember Warden.',
};

function setup(extra: CompendiumEntry[] = []) {
  const h = setupHarness({ withSession: true, campaignSettings: { enabledSources: ['srd-5.2.1', 'gloam', 'notes'] } });
  const accepted = gloamwoodRecords('gloam', { status: 'accepted' }).filter((r) => r.data !== null);
  const index = createRulesIndex([SRD_GOBLIN, ...materializeEntries(gloamwoodEntries(), accepted, [gloamwoodSource()]), ...extra]);
  setDmDeps({ rulesIndex: async () => index });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, index, run: (name: string, input: unknown) => runTool(name, input, ctx) };
}

describe('get_entry and lookup_rules for reviewed imports (spec §6.7)', () => {
  it('puts the stats line inside the imported-content wrapper, and says "reviewed" in the heading', async () => {
    const h = setup();
    const out = await h.run('get_entry', { name: 'Glimmerwing Drake' });
    expect(out.content.startsWith(`<imported-content source="${GLOAMWOOD_TITLE}">\n# Glimmerwing Drake (monster · ${GLOAMWOOD_TITLE}, reviewed) — Bestiary › Glimmerwing Drake`)).toBe(true);
    expect(out.content).toContain('\n\nReviewed stats: Large Dragon · AC 17 (natural armor) · HP 52 (8d10 + 8)');
    expect(out.content.endsWith('</imported-content>')).toBe(true);
    // Redaction takes the stats line with the text (exports keep neither).
    expect(redactImported(out.content)).toBe(`[Text from the player's imported book "${GLOAMWOOD_TITLE}" was left out of this copy.]`);
    const hits = await h.run('lookup_rules', { query: 'Glimmerwing Drake', kinds: ['monster'] });
    expect(hits.content).toContain(`## Glimmerwing Drake (monster · ${GLOAMWOOD_TITLE}, reviewed)`);
    expect(hits.content).toMatch(/<imported-content source="The Gloamwood Almanac">\n## Glimmerwing Drake[^]*Reviewed stats: Large Dragon[^]*<\/imported-content>/);
  });

  it('adds the "Adapted for 2024" note for older-format content', async () => {
    const h = setup();
    const out = await h.run('get_entry', { name: 'Bramble Hound' });
    expect(out.content).toContain('Adapted for 2024: Older stat block: its initiative is its Dexterity modifier');
  });

  it('keeps the stats line and text within the per-entry and per-call budgets', async () => {
    const huge: CompendiumEntry = { ...SRD_GOBLIN, id: 'lib:gloam:999', sourceId: 'gloam', sourceName: GLOAMWOOD_TITLE, name: 'Endless Drake', text: 'Long text. '.repeat(1500), data: { recordId: 'rec:x', size: 'Large', type: 'Dragon', ac: 17, hp: 52, adaptations: [] } };
    const h = setup([huge]);
    const entry = await h.run('get_entry', { name: 'Endless Drake' });
    const inner = entry.content.replace(/^<imported-content[^>]*>\n/, '').replace(/\n<\/imported-content>$/, '');
    expect(inner).toContain('Reviewed stats: Large Dragon · AC 17 · HP 52');
    const body = inner.slice(inner.indexOf('Reviewed stats'));
    expect(body.length).toBeLessThanOrEqual(RULES_OUTPUT_LIMIT + 80);
    const search = await h.run('lookup_rules', { query: 'Endless Drake', kinds: ['monster'], limit: 1 });
    const block = search.content.slice(search.content.indexOf('Reviewed stats'));
    expect(block.length).toBeLessThanOrEqual(RULES_HIT_LIMIT + 120);
    expect(search.content).toContain('…(truncated — use get_entry for the full text)');
  });

  it('names other allowed entries with the same name and kind', async () => {
    const h = setup([NOTES_WARDEN]);
    const out = await h.run('get_entry', { name: 'Ember Warden', kind: 'subclass' });
    expect(out.content).toContain('Also named this: Ember Warden (Gloamwood Notes). Use lookup_rules to read them.');
    const alone = await h.run('get_entry', { name: 'Glimmerwing Drake' });
    expect(alone.content).not.toContain('Also named this');
  });
});

describe('findAllowedEntry ranks like the index (spec §6.2)', () => {
  it('prefers the SRD stat block to an unreviewed import, and a reviewed import to the SRD', async () => {
    const h = setup();
    const campaign = h.s().campaign;
    if (!campaign) throw new Error('no campaign');
    expect(findAllowedEntry(h.index, 'Goblin Warrior', { kind: 'monster', campaign })?.id).toBe('srd:monster:goblin-warrior');
    const reviewedGoblin: CompendiumEntry = { ...SRD_GOBLIN, id: 'lib:gloam:goblin', sourceId: 'gloam', sourceName: GLOAMWOOD_TITLE, data: { recordId: 'rec:gloam:monster:goblin', size: 'Small' } };
    const index = createRulesIndex([SRD_GOBLIN, reviewedGoblin]);
    expect(findAllowedEntry(index, 'Goblin Warrior', { kind: 'monster', campaign })?.id).toBe('lib:gloam:goblin');
    // When the index's pick is off-limits, the fallback ranks the same way.
    const offCampaign = { ...campaign, settings: { ...campaign.settings, enabledSources: ['srd-5.2.1'] } };
    const limited = Object.assign(Object.create(index) as typeof index, { sources: () => [{ id: 'srd-5.2.1', name: 'SRD 5.2.1', count: 1 }] });
    expect(findAllowedEntry(limited, 'Goblin Warrior', { kind: 'monster', campaign: offCampaign })?.id).toBe('srd:monster:goblin-warrior');
  });
});
