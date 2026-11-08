import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/engine', () => import('../testing/fakeEngine'));
vi.mock('@/data', () => import('../testing/fakeData'));
vi.mock('@/state/gameStore', () => import('../testing/fakeGameStoreModule'));

import { sampleMappedCombat } from '@/test/fixtures';
import type { LogEntry, ToolLogEntry, TransformationsMode } from '@/types';
import { deps, resetDmDeps } from '../deps';
import { setupHarness, type Harness } from '../testing/harness';
import type { ToolContext } from './context';
import { runTool } from './handlers';

afterEach(() => resetDmDeps());

function setup(transformations?: TransformationsMode): Harness & { run: (input: Record<string, unknown>) => ReturnType<typeof runTool> } {
  const h = setupHarness({ withSession: true, campaignSettings: { playerRollMode: 'auto', ...(transformations ? { transformations } : {}) } });
  const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
  return { ...h, run: (input) => runTool('transform_character', input, ctx) };
}

const toolLines = (log: LogEntry[]) => log.filter((e): e is ToolLogEntry => e.kind === 'tool');

const BEGIN = {
  action: 'begin',
  name: 'Vampirism',
  summary: 'Strength in the dark and a thirst for blood; the sun becomes an enemy.',
  origin: 'accepted',
  player_chose_it: true,
  stage: 'Fledgling',
  how_it_ends: 'Slay the vampire lord who sired you before the third new moon.',
  features_add: [
    { name: 'Vampiric Bite', description: 'Bite: 1d6 piercing + 1d6 necrotic; regain HP equal to the necrotic damage.', uses_max: 1, recharge: 'long' },
    { name: 'Sunlight Sensitivity', description: 'Disadvantage on attack rolls and Perception checks in sunlight.' },
  ],
  defenses_add: { resistances: ['Necrotic'], vulnerabilities: ['Radiant'] },
  darkvision: 120,
  reason: 'Drank from Count Varo\'s chalice, knowing the price',
};

describe('transform_character: begin', () => {
  it('applies an accepted transformation the player chose, with a prominent log line linked to it', async () => {
    const h = setup();
    const out = await h.run(BEGIN);
    expect(out.isError).toBeUndefined();
    const c = h.s().character!;
    const [t] = c.transformations ?? [];
    expect(t).toMatchObject({ name: 'Vampirism', origin: 'accepted', status: 'active', stage: 'Fledgling', startedSession: 1 });
    expect(c.features.filter((f) => f.source === 'transformation').map((f) => f.name)).toEqual(['Vampiric Bite', 'Sunlight Sensitivity']);
    expect(c.damageResistances).toEqual(['Necrotic']);
    expect(c.darkvision).toBe(120);

    const [line] = toolLines(h.s().log);
    expect(line).toMatchObject({ tool: 'transform_character', icon: 'transform', refId: t.id, summary: 'Transformation: Vampirism begins — Fledgling' });
    expect(line.secret).toBeUndefined();
    expect(line.detail).toContain('**Origin:** chosen by the hero');
    expect(line.detail).toContain('- Gained feature: Vampiric Bite (1 use per Long Rest)');
    expect(line.detail).toContain('**How it could end:** Slay the vampire lord');
    expect(line.detail).toContain("**Why:** Drank from Count Varo's chalice");

    expect(out.content.split('\n')[0]).toBe('Transformation: Vampirism begins — Fledgling.');
    expect(out.content).toContain('- Resistance to Necrotic damage');
    expect(out.content).toContain('- Darkvision 60 ft → 120 ft');
    expect(out.content).toContain('How it could end: Slay the vampire lord');
    expect(out.content).toContain('Status: Mira Voss');
  });

  it('requires the player to have chosen an accepted transformation', async () => {
    const h = setup('consequences');
    for (const consent of [{}, { player_chose_it: false }]) {
      const out = await h.run({ ...BEGIN, player_chose_it: undefined, ...consent });
      expect(out.isError).toBe(true);
      expect(out.content).toContain('only after the player has explicitly chosen it in the fiction');
      expect(out.content).toContain('Nothing changed.');
    }
    expect(h.s().character?.transformations).toBeUndefined();
    expect(h.s().log).toHaveLength(0);
  });

  it('refuses an imposed transformation unless the rule is Consequences (a missing rule means Offered)', async () => {
    const imposed = { ...BEGIN, origin: 'imposed', player_chose_it: undefined };
    for (const mode of [undefined, 'offered'] as const) {
      const h = setup(mode);
      const out = await h.run(imposed);
      expect(out.isError).toBe(true);
      expect(out.content).toContain("transformations rule is Offered: nothing changes unless the player chooses it");
      expect(h.s().character?.transformations).toBeUndefined();
    }
    const h = setup('consequences');
    const withoutPathBack = await h.run({ ...imposed, how_it_ends: undefined });
    expect(withoutPathBack.isError).toBe(true);
    expect(withoutPathBack.content).toContain('always needs a story path to resist, reverse or cure it');
    const out = await h.run(imposed);
    expect(out.isError).toBeUndefined();
    expect(h.s().character?.transformations?.[0]).toMatchObject({ origin: 'imposed', howItEnds: expect.stringContaining('vampire lord') });
    expect(toolLines(h.s().log)[0].detail).toContain('**Origin:** imposed by the story');
  });

  it('refuses everything new when transformations are off', async () => {
    const h = setup('off');
    const out = await h.run(BEGIN);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Transformations are off in this campaign: the hero stays as built');
    expect(h.s().character?.transformations).toBeUndefined();
  });

  it('checks the shape of each action and refuses a duplicate', async () => {
    const h = setup();
    expect((await h.run({ ...BEGIN, origin: undefined })).content).toContain('begin needs origin');
    expect((await h.run({ ...BEGIN, summary: undefined })).content).toContain('begin needs summary');
    expect((await h.run({ ...BEGIN, features_remove: ['Bite'] })).content).toMatch(/begin: features_remove doesn't apply/);
    const invalid = await h.run({ ...BEGIN, origin: 'forced' });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toMatch(/^Invalid input for transform_character/);
    await h.run(BEGIN);
    const again = await h.run({ ...BEGIN, name: 'vampirism' });
    expect(again.isError).toBe(true);
    expect(again.content).toContain('Vampirism is already active (Fledgling): advance it to a new stage instead.');
    expect(h.s().character?.transformations).toHaveLength(1);
  });
});

describe('transform_character: advance and end', () => {
  const ADVANCE = {
    action: 'advance',
    name: 'vampirism',
    stage: 'Thrall',
    features_add: [{ name: 'Spider Climb', description: 'Climb sheer walls and ceilings.' }],
    features_remove: ['Sunlight Sensitivity'],
    other_speeds: { climb: 30 },
    reason: 'Fed again, willingly',
  };

  async function begun(mode?: TransformationsMode) {
    const h = setup(mode);
    if (mode === 'off') {
      // Begun while the rule allowed it; the player has since turned transformations off.
      await h.s().updateCampaign((c) => ({ ...c, settings: { ...c.settings, transformations: 'offered' } }));
      expect((await h.run(BEGIN)).isError).toBeUndefined();
      await h.s().updateCampaign((c) => ({ ...c, settings: { ...c.settings, transformations: 'off' } }));
    } else {
      expect((await h.run(BEGIN)).isError).toBeUndefined();
    }
    return h;
  }

  it('advances a stage in an Offered campaign only when the player chose it', async () => {
    const h = await begun('offered');
    const unchosen = await h.run(ADVANCE);
    expect(unchosen.isError).toBe(true);
    expect(unchosen.content).toContain('a transformation only changes when the player chooses it');
    expect(h.s().character?.transformations?.[0].stage).toBe('Fledgling');

    const out = await h.run({ ...ADVANCE, player_chose_it: true });
    expect(out.isError).toBeUndefined();
    const c = h.s().character!;
    expect(c.transformations?.[0].stage).toBe('Thrall');
    expect(c.features.filter((f) => f.source === 'transformation').map((f) => f.name)).toEqual(['Vampiric Bite', 'Spider Climb']);
    expect(c.otherSpeeds).toEqual({ climb: 30 });
    expect(toolLines(h.s().log).at(-1)).toMatchObject({ icon: 'transform', summary: 'Transformation: Vampirism — Fledgling → Thrall', refId: c.transformations?.[0].id });
    expect(out.content).toContain('- Lost feature: Sunlight Sensitivity');
  });

  it('lets consequences advance a stage without the player choosing it', async () => {
    const h = await begun('consequences');
    expect((await h.run(ADVANCE)).isError).toBeUndefined();
    expect(h.s().character?.transformations?.[0].stage).toBe('Thrall');
  });

  it('ends a transformation — even when transformations are now off — undoing what it granted', async () => {
    const h = await begun('off');
    expect((await h.run({ ...ADVANCE, player_chose_it: true })).isError).toBe(true);
    const out = await h.run({ action: 'end', name: 'Vampirism', reason: 'Count Varo is slain' });
    expect(out.isError).toBeUndefined();
    const c = h.s().character!;
    expect(c.transformations?.[0]).toMatchObject({ status: 'ended', endedSession: 1 });
    expect(c.features.some((f) => f.source === 'transformation')).toBe(false);
    expect(c.damageResistances).toEqual([]);
    expect(c.darkvision).toBe(60);
    const line = toolLines(h.s().log).at(-1);
    expect(line).toMatchObject({ icon: 'transform', summary: 'Transformation ended: Vampirism' });
    expect(line?.detail).toContain('**Undone:**');
    expect(line?.detail).toContain('- Lost feature: Vampiric Bite');
    expect(out.content).toContain('anything that lingers');
  });

  it('explains what an end takes, and which transformations are active', async () => {
    const h = await begun();
    const extra = await h.run({ action: 'end', name: 'Vampirism', reason: 'Cured', features_add: [{ name: 'Scar', description: 'A pale scar.' }] });
    expect(extra.isError).toBe(true);
    expect(extra.content).toContain('`end` takes only name and reason');
    const unknown = await h.run({ action: 'end', name: 'Lycanthropy', reason: 'Cured' });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('no active transformation named "Lycanthropy" (active: Vampirism)');
    expect((await h.run({ action: 'advance', name: 'Vampirism', reason: 'x', player_chose_it: true })).content).toContain('advance needs the new stage');
    expect((await h.run({ ...ADVANCE, origin: 'imposed', player_chose_it: true })).content).toContain('The origin is set when a transformation begins.');
  });
});

describe('transform_character during a mapped fight (D39)', () => {
  it("re-fits the hero's space when the size changes and says so", async () => {
    const h = setupHarness({ withSession: true, campaignSettings: { playerRollMode: 'auto' }, state: { combat: sampleMappedCombat({ heroTurn: true }) } });
    const ctx: ToolContext = { deps: deps(), signal: new AbortController().signal, status: vi.fn() };
    const out = await runTool('transform_character', { ...BEGIN, name: 'Giant Blood', size: 'Large' }, ctx);
    expect(out.isError).toBeUndefined();
    expect(h.s().character?.size).toBe('Large');
    expect(out.content.split('\n').at(-1)).toBe('Map: Mira Voss is now Large (B6:C7).');
    // Nothing else moved; a change that keeps the size says nothing about the map.
    expect(h.s().combat?.combatants.find((c) => c.isPlayer)?.position).toEqual({ x: 1, y: 5 });
    const again = await runTool('transform_character', { action: 'advance', name: 'Giant Blood', stage: 'Stage 2', player_chose_it: true, darkvision: 60, reason: 'The blood wakes' }, ctx);
    expect(again.content).not.toContain('Map:');
  });
});
