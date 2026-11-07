import { describe, expect, it } from 'vitest';
import type { Character } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import { addCondition, applyDamage } from './character';
import {
  activeTransformations,
  advanceTransformation,
  beginTransformation,
  endTransformation,
  findTransformation,
  transformationFeatures,
  transformationGrants,
  type BeginTransformationSpec,
  type TransformationOptions,
} from './transform';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);

function opts(overrides: Partial<TransformationOptions> = {}): TransformationOptions {
  let n = 0;
  return { session: 3, now: 1_800_000_000_000, newId: () => `tf-${++n}`, ...overrides };
}

const vampirism = (overrides: Partial<BeginTransformationSpec> = {}): BeginTransformationSpec => ({
  name: 'Vampirism',
  summary: 'The hunger of the night: strength in darkness, a thirst for blood, and the sun as an enemy.',
  origin: 'accepted',
  stage: 'Fledgling',
  howItEnds: 'Slay the vampire lord who sired you before the third new moon.',
  features: [
    { name: 'Vampiric Bite', description: 'Bite: 1d6 piercing + 1d6 necrotic; regain HP equal to the necrotic damage.', uses: { max: 1, recharge: 'long' } },
    { name: 'Sunlight Sensitivity', description: 'Disadvantage on attack rolls and Perception checks in sunlight.' },
  ],
  defenses: { resistances: ['necrotic'], vulnerabilities: ['Radiant'] },
  darkvision: 120,
  ...overrides,
});

const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);

describe('beginTransformation', () => {
  it('records the transformation and applies its features, defenses and senses at once', () => {
    const before = mira();
    const r = beginTransformation(before, vampirism(), opts());
    const c = r.character;
    expect(r.transformation).toMatchObject({
      id: 'tf-1',
      name: 'Vampirism',
      origin: 'accepted',
      status: 'active',
      stage: 'Fledgling',
      howItEnds: 'Slay the vampire lord who sired you before the third new moon.',
      startedSession: 3,
      createdAt: 1_800_000_000_000,
    });
    expect(c.transformations).toHaveLength(1);
    const features = transformationFeatures(c, r.transformation!);
    expect(features.map((f) => [f.name, f.source, f.sourceName])).toEqual([
      ['Vampiric Bite', 'transformation', 'Vampirism'],
      ['Sunlight Sensitivity', 'transformation', 'Vampirism'],
    ]);
    expect(features[0].uses).toEqual({ max: 1, used: 0, recharge: 'long' });
    expect(c.damageResistances).toEqual(['Necrotic']);
    expect(c.damageVulnerabilities).toEqual(['Radiant']);
    // Darkvision grants set a longer range; they don't add (60 → 120, not 180).
    expect(c.darkvision).toBe(120);
    expect(r.events[0]).toMatchObject({ type: 'transformation', message: expect.stringContaining('Transformation begins: Vampirism (Fledgling)') });
    expect(messages(r)).toEqual(expect.arrayContaining(['Gained feature: Vampiric Bite (1 use per Long Rest)', 'Resistance to Necrotic damage', 'Darkvision 60 ft → 120 ft']));
    // Pure: the input character is untouched.
    expect(before.features).toHaveLength(3);
    expect(before.transformations).toBeUndefined();
  });

  it("doesn't add a defense the hero already has, and keeps a longer Darkvision (SRD 5.2.1: Resistance doesn't stack)", () => {
    const tiefling = mira({ damageResistances: ['necrotic'], darkvision: 150 });
    const r = beginTransformation(tiefling, vampirism(), opts());
    expect(r.character.damageResistances).toEqual(['necrotic']);
    expect(r.character.darkvision).toBe(150);
    expect(transformationGrants(r.transformation!).defenses?.resistances).toEqual({ granted: ['Necrotic'], added: [] });
    expect(messages(r)).toContain('Darkvision stays 150 ft (Vampirism gives 120 ft)');
  });

  it('changes speed, size and ability scores; a Constitution change moves HP from level 1 (SRD 5.2.1 Hit Points)', () => {
    const r = beginTransformation(
      mira(),
      vampirism({
        speedChange: 10,
        size: 'Large',
        otherSpeeds: { climb: 30 },
        abilityChanges: [
          { ability: 'con', change: 2 },
          { ability: 'dex', change: 2 },
        ],
      }),
      opts(),
    );
    const c = r.character;
    expect(c.speed).toBe(40);
    expect(c.size).toBe('Large');
    expect(c.otherSpeeds).toEqual({ climb: 30 });
    expect(c.abilityScores).toMatchObject({ con: 15, dex: 16 });
    // Wizard 3: CON modifier +1 → +2 = +3 HP maximum, and current HP moves with it.
    expect(c.hp).toMatchObject({ max: 20, current: 15 });
    // Unarmored AC follows the new Dexterity: 10 + 3.
    expect(c.armorClass).toBe(13);
    expect(transformationGrants(r.transformation!)).toMatchObject({ speed: 10, abilities: { con: 2, dex: 2 } });
  });

  it('keeps ability scores within 1–30 (SRD 5.2.1) and records only what was applied', () => {
    const giant = mira({ abilityScores: { ...mira().abilityScores, str: 29, cha: 2 } });
    const r = beginTransformation(
      giant,
      vampirism({ abilityChanges: [{ ability: 'str', change: 4 }, { ability: 'cha', change: -4 }] }),
      opts(),
    );
    expect(r.character.abilityScores).toMatchObject({ str: 30, cha: 1 });
    expect(transformationGrants(r.transformation!).abilities).toEqual({ str: 1, cha: -1 });
    const ended = endTransformation(r.character, 'Vampirism', opts()).character;
    expect(ended.abilityScores).toMatchObject({ str: 29, cha: 2 });
  });

  it('gives a feature a distinct name when the hero already has one by that name', () => {
    const elf = mira({ features: [...mira().features, { id: 'f-dv', name: 'Darkvision', source: 'species', sourceName: 'Elf', description: '60 ft.' }] });
    const r = beginTransformation(elf, vampirism({ features: [{ name: 'Darkvision', description: '120 ft in darkness.' }] }), opts());
    expect(r.character.features.find((f) => f.id === 'f-dv')).toMatchObject({ name: 'Darkvision', source: 'species' });
    expect(transformationFeatures(r.character, r.transformation!).map((f) => f.name)).toEqual(['Darkvision (Vampirism)']);
    const ended = endTransformation(r.character, 'vampirism', opts()).character;
    expect(ended.features.map((f) => f.name)).toContain('Darkvision');
    expect(ended.features.some((f) => f.name === 'Darkvision (Vampirism)')).toBe(false);
  });

  it('normalizes condition immunities so the engine enforces them, ending a condition the hero is now immune to', () => {
    const r = beginTransformation(mira(), vampirism({ defenses: { conditionImmunities: ['poisoned'] } }), opts());
    expect(r.character.conditionImmunities).toEqual(['Poisoned']);
    expect(addCondition(r.character, { id: 'poisoned' }).events[0]).toMatchObject({ type: 'warning' });
    const sick = mira({ conditions: [{ id: 'poisoned', source: 'Spider venom' }, { id: 'prone' }] });
    const cured = beginTransformation(sick, vampirism({ defenses: { conditionImmunities: ['Poisoned'] } }), opts());
    expect(cured.character.conditions.map((x) => x.id)).toEqual(['prone']);
    expect(cured.events.some((e) => e.type === 'condition-removed')).toBe(true);
  });

  it('refuses a duplicate, a nameless or summary-less transformation without changing anything', () => {
    const once = beginTransformation(mira(), vampirism(), opts()).character;
    const again = beginTransformation(once, vampirism({ name: 'vampirism' }), opts());
    expect(again.transformation).toBeUndefined();
    expect(again.character).toBe(once);
    expect(again.events[0]).toMatchObject({ type: 'warning', message: expect.stringContaining('already active') });
    expect(beginTransformation(mira(), vampirism({ name: '  ' }), opts()).transformation).toBeUndefined();
    expect(beginTransformation(mira(), vampirism({ summary: '' }), opts()).events[0].message).toMatch(/needs a summary/);
  });

  it('can begin again after an earlier one of the same name ended (a relapse)', () => {
    const cured = endTransformation(beginTransformation(mira(), vampirism(), opts()).character, 'Vampirism', opts()).character;
    const relapse = beginTransformation(cured, vampirism(), opts({ newId: () => 'tf-relapse' }));
    expect(relapse.transformation?.id).toBe('tf-relapse');
    expect(relapse.character.transformations?.map((t) => t.status)).toEqual(['ended', 'active']);
  });
});

describe('advanceTransformation', () => {
  const begun = () => beginTransformation(mira(), vampirism(), opts()).character;

  it('moves to the next stage and adds its traits', () => {
    const r = advanceTransformation(begun(), 'vampirism', { stage: 'Thrall', summary: 'The thirst is harder to deny.', features: [{ name: 'Spider Climb', description: 'Climb sheer walls.' }], otherSpeeds: { climb: 30 } }, opts({ now: 1_800_000_000_500, newId: () => 'f-climb' }));
    expect(r.transformation).toMatchObject({ stage: 'Thrall', summary: 'The thirst is harder to deny.', updatedAt: 1_800_000_000_500 });
    expect(transformationFeatures(r.character, r.transformation!).map((f) => f.name)).toEqual(['Vampiric Bite', 'Sunlight Sensitivity', 'Spider Climb']);
    expect(r.character.otherSpeeds).toEqual({ climb: 30 });
    expect(r.events[0].message).toBe('Vampirism: Fledgling → Thrall');
  });

  it("updates one of its own features in place, and can take its own features away", () => {
    const start = begun();
    const biteId = start.features.find((f) => f.name === 'Vampiric Bite')?.id;
    const r = advanceTransformation(
      start,
      'Vampirism',
      {
        stage: 'Spawn',
        features: [{ name: 'vampiric bite', description: 'Bite: 2d6 piercing + 2d6 necrotic.', uses: { max: 2, recharge: 'long' } }],
        removeFeatures: ['Sunlight Sensitivity', 'Arcane Recovery'],
      },
      opts(),
    );
    const bite = r.character.features.find((f) => f.id === biteId);
    expect(bite).toMatchObject({ name: 'Vampiric Bite', description: 'Bite: 2d6 piercing + 2d6 necrotic.', uses: { max: 2, used: 0 } });
    expect(r.character.features.some((f) => f.name === 'Sunlight Sensitivity')).toBe(false);
    // Only its own features can be taken away by a stage.
    expect(r.character.features.some((f) => f.name === 'Arcane Recovery')).toBe(true);
    expect(r.events.some((e) => e.type === 'warning' && e.message.includes('Arcane Recovery'))).toBe(true);
    expect(r.transformation?.featureIds).toEqual([biteId]);
  });

  it('refuses an unknown or ended transformation', () => {
    expect(advanceTransformation(begun(), 'Lycanthropy', { stage: 'Full moon' }, opts()).events[0].message).toMatch(/No active transformation named "Lycanthropy".*Active: Vampirism/);
    const cured = endTransformation(begun(), 'Vampirism', opts()).character;
    expect(advanceTransformation(cured, 'Vampirism', { stage: 'Thrall' }, opts()).transformation).toBeUndefined();
    expect(findTransformation(cured, 'Vampirism')).toBeUndefined();
  });
});

describe('endTransformation', () => {
  it('undoes exactly what it granted and keeps the record as history', () => {
    const changed = beginTransformation(
      mira({ damageResistances: ['Fire'] }),
      vampirism({ defenses: { resistances: ['Necrotic', 'fire'], conditionImmunities: ['Charmed'] }, speedChange: -10, size: 'Small', abilityChanges: [{ ability: 'con', change: 2 }] }),
      opts(),
    ).character;
    const r = endTransformation(changed, 'Vampirism', opts({ session: 5 }));
    const c = r.character;
    expect(c.features.map((f) => f.name)).toEqual(['Arcane Recovery', 'Magic Initiate (Wizard)', 'Fey Ancestry']);
    // The hero's own Fire resistance stays; the granted Necrotic one goes.
    expect(c.damageResistances).toEqual(['Fire']);
    expect(c.conditionImmunities).toEqual([]);
    expect(c.darkvision).toBe(60);
    expect(c.speed).toBe(30);
    expect(c.size).toBe('Medium');
    expect(c.abilityScores.con).toBe(13);
    expect(c.hp).toMatchObject({ max: 17, current: 12 });
    expect(r.transformation).toMatchObject({ status: 'ended', endedSession: 5 });
    expect(activeTransformations(c)).toEqual([]);
    expect(c.transformations).toHaveLength(1);
    expect(messages(r)).toEqual(expect.arrayContaining(['Transformation ends: Vampirism', 'Lost feature: Vampiric Bite', 'Loses Resistance to Necrotic damage', 'Darkvision 120 ft → 60 ft']));
  });

  it('a defense two transformations grant stays until the last of them ends', () => {
    const one = beginTransformation(mira(), vampirism(), opts()).character;
    const two = beginTransformation(one, { name: 'Shadow Pact', summary: 'Bound to the Shadowfell.', origin: 'imposed', defenses: { resistances: ['Necrotic'] } }, opts({ newId: () => 'tf-pact' })).character;
    const vampireCured = endTransformation(two, 'Vampirism', opts()).character;
    expect(vampireCured.damageResistances).toEqual(['Necrotic']);
    const pactBroken = endTransformation(vampireCured, 'Shadow Pact', opts()).character;
    expect(pactBroken.damageResistances).toEqual([]);
  });

  it('restores Darkvision and size correctly whichever of two transformations ends first', () => {
    const owl = { name: 'Owl Blessing', summary: 'Eyes of the night.', origin: 'accepted' as const, darkvision: 90, size: 'Small' as const };
    const start = (): Character => {
      const a = beginTransformation(mira(), owl, opts({ newId: () => 'tf-owl', now: 1 })).character;
      return beginTransformation(a, vampirism({ size: 'Large' }), opts({ now: 2 })).character;
    };
    const both = start();
    expect([both.darkvision, both.size]).toEqual([120, 'Large']);

    const owlFirst = endTransformation(both, 'Owl Blessing', opts()).character;
    expect([owlFirst.darkvision, owlFirst.size]).toEqual([120, 'Large']);
    const thenVampire = endTransformation(owlFirst, 'Vampirism', opts()).character;
    expect([thenVampire.darkvision, thenVampire.size]).toEqual([60, 'Medium']);

    const vampireFirst = endTransformation(start(), 'Vampirism', opts()).character;
    expect([vampireFirst.darkvision, vampireFirst.size]).toEqual([90, 'Small']);
    const thenOwl = endTransformation(vampireFirst, 'Owl Blessing', opts()).character;
    expect([thenOwl.darkvision, thenOwl.size]).toEqual([60, 'Medium']);
  });

  it('leaves a sense changed by something else since, with a warning', () => {
    const begun = beginTransformation(mira(), vampirism(), opts()).character;
    const edited = { ...begun, darkvision: 300 };
    const r = endTransformation(edited, 'Vampirism', opts());
    expect(r.character.darkvision).toBe(300);
    expect(r.events.some((e) => e.type === 'warning' && e.message.startsWith('Darkvision left at 300 ft'))).toBe(true);
  });

  it('keeps a downed hero at 0 HP when a Constitution bonus goes away', () => {
    const begun = beginTransformation(mira(), vampirism({ abilityChanges: [{ ability: 'con', change: 2 }] }), opts()).character;
    const down = applyDamage(begun, begun.hp.current).character;
    const ended = endTransformation(down, 'Vampirism', opts()).character;
    expect(ended.hp).toMatchObject({ max: 17, current: 0 });
  });

  it('refuses a transformation that is not active', () => {
    const r = endTransformation(mira(), 'Vampirism', opts());
    expect(r.transformation).toBeUndefined();
    expect(r.events[0].message).toMatch(/No active transformation named "Vampirism".*Active: none/);
  });
});
