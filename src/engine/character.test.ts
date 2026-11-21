import { describe, expect, it } from 'vitest';
import type { Character, Feature } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import {
  addCondition,
  addFeature,
  addItem,
  addSpell,
  applyDamage,
  applyHealing,
  changeAbilityScore,
  changeCurrency,
  changeExhaustion,
  clearTempHp,
  concentrationSaveDC,
  createBlankCharacter,
  featureLabel,
  findFeature,
  findItem,
  formatCurrency,
  gainXp,
  recordDeathSave,
  removeCondition,
  removeFeature,
  removeItem,
  removeSpell,
  restoreFeature,
  setConcentration,
  setHeroicInspiration,
  setTempHp,
  stabilize,
  totalGp,
  updateItem,
  useFeature,
} from './character';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);
/** Mira at 0 HP, unconscious and making death saves. */
const dying = (overrides: Partial<Character> = {}) =>
  applyDamage(mira(overrides), 12).character;
const ids = (c: Character) => c.conditions.map((x) => x.id);

describe('createBlankCharacter', () => {
  it('creates a sane level-1 shell', () => {
    const c = createBlankCharacter('camp-9');
    expect(c.campaignId).toBe('camp-9');
    expect(c.id).toBeTruthy();
    expect(c.abilityScores).toEqual({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
    expect(c.classes).toEqual([]);
    expect(c.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false });
    expect(c.currency).toEqual({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 });
    expect(createBlankCharacter('x').id).not.toBe(c.id);
  });
});

describe('applyDamage', () => {
  it('subtracts damage and describes it', () => {
    const { character, events } = applyDamage(mira(), 5, { damageType: 'slashing' });
    expect(character.hp.current).toBe(7);
    expect(events[0]).toEqual({ type: 'hp-changed', message: 'HP 12 → 7 (5 slashing)' });
    expect(character.updatedAt).toBeGreaterThan(mira().updatedAt);
  });

  it('spends temporary HP first (SRD 5.2.1: 5 temp, 7 damage → lose 2 HP)', () => {
    const { character } = applyDamage(mira({ hp: { max: 17, current: 12, temp: 5 } }), 7);
    expect(character.hp).toEqual({ max: 17, current: 10, temp: 0 });
    const absorbed = applyDamage(mira({ hp: { max: 17, current: 12, temp: 10 } }), 4);
    expect(absorbed.character.hp).toEqual({ max: 17, current: 12, temp: 6 });
    expect(absorbed.events[0].type).toBe('temp-hp');
  });

  it('drops to 0: Unconscious, death saves reset, concentration ends', () => {
    const c = mira({ spellcasting: { ...mira().spellcasting!, concentratingOn: 'Detect Magic' } });
    const { character, events } = applyDamage(c, 12);
    expect(character.hp.current).toBe(0);
    expect(ids(character)).toContain('unconscious');
    expect(character.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false });
    expect(character.spellcasting?.concentratingOn).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['dropped-to-zero', 'condition-removed']);
  });

  it('massive damage kills outright (SRD example: max 12, at 6, takes 18)', () => {
    const c = mira({ hp: { max: 12, current: 6, temp: 0 } });
    const { character, events } = applyDamage(c, 18);
    expect(character.deathSaves.dead).toBe(true);
    expect(character.hp.current).toBe(0);
    expect(events[0].type).toBe('died');
    // One point short of the threshold: unconscious, not dead.
    expect(applyDamage(c, 17).character.deathSaves.dead).toBe(false);
    expect(applyDamage(mira(), 12 + 16).character.deathSaves.dead).toBe(false);
    expect(applyDamage(mira(), 12 + 17).character.deathSaves.dead).toBe(true);
  });

  it('damage at 0 HP: one failure, two on a critical, death on the third', () => {
    const one = applyDamage(dying(), 3);
    expect(one.character.deathSaves.failures).toBe(1);
    expect(one.events[0].type).toBe('death-save');
    const crit = applyDamage(dying(), 3, { critical: true });
    expect(crit.character.deathSaves.failures).toBe(2);
    const dead = applyDamage(crit.character, 1);
    expect(dead.character.deathSaves).toMatchObject({ failures: 3, dead: true });
    expect(dead.events[0].type).toBe('died');
  });

  it('damage at 0 HP equal to the HP maximum kills', () => {
    const { character } = applyDamage(dying(), 17);
    expect(character.deathSaves.dead).toBe(true);
  });

  it('a Stable character who takes damage starts dying again', () => {
    const stable = { ...dying(), deathSaves: { successes: 0, failures: 0, stable: true, dead: false } };
    const { character, events } = applyDamage(stable, 2);
    expect(character.deathSaves).toMatchObject({ stable: false, failures: 1 });
    expect(events[0].message).toMatch(/No longer Stable/);
  });

  it("starts a Stable character's tallies from zero when damage sets them dying again, however Stable was marked (SRD 5.2.1 Death Saving Throws)", () => {
    // The sheet's pips mark Stable at the third success without resetting the tallies.
    const ticked = { ...dying(), deathSaves: { successes: 3, failures: 2, stable: true, dead: false } };
    const { character } = applyDamage(ticked, 2);
    expect(character.deathSaves).toEqual({ successes: 0, failures: 1, stable: false, dead: false });
    expect(applyDamage(ticked, 2, { critical: true }).character.deathSaves).toEqual({ successes: 0, failures: 2, stable: false, dead: false });
  });

  it('warns about Concentration checks and ignores damage to the dead', () => {
    const c = mira({ spellcasting: { ...mira().spellcasting!, concentratingOn: 'Detect Magic' } });
    const { events } = applyDamage(c, 5);
    expect(events[1]).toEqual({ type: 'warning', message: 'Concentration check: DC 10 Constitution saving throw to keep Detect Magic.' });
    expect(concentrationSaveDC(30)).toBe(15);
    expect(concentrationSaveDC(100)).toBe(30);
    const dead = applyDamage(mira({ hp: { max: 12, current: 6, temp: 0 } }), 18).character;
    expect(applyDamage(dead, 5).character).toBe(dead);
    expect(applyDamage(mira(), 0).events).toEqual([]);
  });
});

describe('applyHealing and temporary HP', () => {
  it('heals up to the maximum', () => {
    const { character, events } = applyHealing(mira(), 8);
    expect(character.hp.current).toBe(17);
    expect(events[0].message).toBe('HP 12 → 17 (healed 5)');
    expect(applyHealing(mira({ hp: { max: 17, current: 17, temp: 0 } }), 5).events[0].type).toBe('warning');
  });

  it('healing from 0 HP revives: Unconscious ends, Prone remains, death saves reset', () => {
    const down = { ...dying(), deathSaves: { successes: 1, failures: 2, stable: false, dead: false } };
    const { character, events } = applyHealing(down, 4);
    expect(character.hp.current).toBe(4);
    expect(ids(character)).not.toContain('unconscious');
    expect(ids(character)).toContain('prone');
    expect(character.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false });
    expect(events[0].type).toBe('revived');
  });

  it('the dead cannot be healed', () => {
    const dead = applyDamage(mira({ hp: { max: 12, current: 6, temp: 0 } }), 18).character;
    const result = applyHealing(dead, 10);
    expect(result.character).toBe(dead);
    expect(result.events[0].type).toBe('warning');
  });

  it("temporary HP don't stack: keep the higher", () => {
    const eight = setTempHp(mira(), 8).character;
    expect(eight.hp.temp).toBe(8);
    const kept = setTempHp(eight, 5);
    expect(kept.character).toBe(eight);
    expect(kept.events[0].message).toMatch(/don't stack/);
    expect(setTempHp(eight, 10).character.hp.temp).toBe(10);
    expect(clearTempHp(eight).character.hp.temp).toBe(0);
  });

  it("temporary HP at 0 HP don't wake you", () => {
    const { character } = setTempHp(dying(), 5);
    expect(character.hp.current).toBe(0);
    expect(ids(character)).toContain('unconscious');
  });
});

describe('stabilize (SRD 5.2.1 Stabilizing a Character)', () => {
  it('makes a dying hero Stable at 0 HP, still Unconscious, with both tallies reset', () => {
    const down = { ...dying(), deathSaves: { successes: 1, failures: 2, stable: false, dead: false } };
    const { character, events } = stabilize(down, 'Spare the Dying');
    expect(character.deathSaves).toEqual({ successes: 0, failures: 0, stable: true, dead: false });
    expect(character.hp.current).toBe(0);
    expect(character.conditions).toEqual(down.conditions);
    expect(events).toEqual([{ type: 'stabilized', message: 'Stabilized (Spare the Dying): Stable at 0 HP (still Unconscious), no more death saving throws unless damaged again.' }]);
    // No more death saves, and damage starts them again from zero.
    expect(recordDeathSave(character, 3).outcome).toBe('stable');
    expect(applyDamage(character, 2).character.deathSaves).toEqual({ successes: 0, failures: 1, stable: false, dead: false });
  });

  it('changes nothing for a hero with HP, the dead or one already Stable', () => {
    const dead = { ...dying(), deathSaves: { successes: 0, failures: 3, stable: false, dead: true } };
    const stable = { ...dying(), deathSaves: { successes: 0, failures: 0, stable: true, dead: false } };
    for (const c of [mira(), dead, stable]) {
      const out = stabilize(c);
      expect(out.character).toBe(c);
      expect(out.events.map((e) => e.type)).toEqual(['warning']);
    }
  });
});

describe('recordDeathSave (SRD 5.2.1)', () => {
  it('10 or higher succeeds; 9 or lower fails', () => {
    const success = recordDeathSave(dying(), 10);
    expect(success.outcome).toBe('success');
    expect(success.character.deathSaves.successes).toBe(1);
    const failure = recordDeathSave(dying(), 9);
    expect(failure.outcome).toBe('failure');
    expect(failure.character.deathSaves.failures).toBe(1);
  });

  it('a natural 1 is two failures', () => {
    const r = recordDeathSave(dying(), 1);
    expect(r.character.deathSaves.failures).toBe(2);
    expect(r.outcome).toBe('failure');
  });

  it('a natural 20 regains 1 HP', () => {
    const r = recordDeathSave(dying(), 20);
    expect(r.outcome).toBe('revived');
    expect(r.character.hp.current).toBe(1);
    expect(ids(r.character)).not.toContain('unconscious');
    expect(ids(r.character)).toContain('prone');
  });

  it('three successes: Stable, tallies reset', () => {
    let c = dying();
    c = recordDeathSave(c, 12).character;
    c = recordDeathSave(c, 15).character;
    const third = recordDeathSave(c, 11);
    expect(third.outcome).toBe('stable');
    expect(third.character.deathSaves).toEqual({ successes: 0, failures: 0, stable: true, dead: false });
    expect(third.character.hp.current).toBe(0);
    expect(recordDeathSave(third.character, 5).outcome).toBe('stable');
  });

  it('three failures: dead', () => {
    let c = dying();
    c = recordDeathSave(c, 5).character;
    const r = recordDeathSave(c, 1);
    expect(r.outcome).toBe('dead');
    expect(r.character.deathSaves).toMatchObject({ failures: 3, dead: true });
    expect(recordDeathSave(r.character, 20).outcome).toBe('dead');
  });

  it('Exhaustion lowers the death save total; naturals still count', () => {
    const tired = dying({ exhaustion: 1 });
    expect(recordDeathSave(tired, 11).outcome).toBe('failure');
    expect(recordDeathSave(tired, 12).outcome).toBe('success');
    expect(recordDeathSave(dying({ exhaustion: 5 }), 20).outcome).toBe('revived');
  });

  it('rejects impossible rolls and conscious characters', () => {
    expect(() => recordDeathSave(dying(), 0)).toThrow(RangeError);
    expect(() => recordDeathSave(dying(), 21)).toThrow(RangeError);
    expect(recordDeathSave(mira(), 15).events[0].type).toBe('warning');
  });
});

describe('conditions', () => {
  it('adds without duplicates and refreshes details', () => {
    const once = addCondition(mira(), { id: 'poisoned', duration: '1 hour' });
    expect(ids(once.character)).toEqual(['poisoned']);
    expect(once.events[0].type).toBe('condition-added');
    expect(once.events[0].message).toMatch(/^Now Poisoned \(1 hour\)/);
    const twice = addCondition(once.character, { id: 'Poisoned', duration: '10 minutes' });
    expect(twice.character.conditions).toEqual([{ id: 'poisoned', duration: '10 minutes' }]);
  });

  it('maps names to standard ids but keeps homebrew names', () => {
    expect(ids(addCondition(mira(), { id: 'knocked prone' }).character)).toEqual(['prone']);
    expect(addCondition(mira(), { id: 'Frightened of the dragon' }).character.conditions[0]).toEqual({
      id: 'frightened',
      source: 'of the dragon',
    });
    expect(ids(addCondition(mira(), { id: 'Poison Mist' }).character)).toEqual(['Poison Mist']);
  });

  it('forwards exhaustion and ends concentration when incapacitated', () => {
    expect(addCondition(mira(), { id: 'exhaustion' }).character.exhaustion).toBe(1);
    expect(addCondition(mira(), { id: 'Exhaustion', level: 2 }).character.exhaustion).toBe(2);
    const c = mira({ spellcasting: { ...mira().spellcasting!, concentratingOn: 'Detect Magic' } });
    const stunned = addCondition(c, { id: 'stunned' });
    expect(stunned.character.spellcasting?.concentratingOn).toBeNull();
    expect(stunned.events.map((e) => e.type)).toEqual(['condition-added', 'condition-removed']);
    expect(addCondition(c, { id: 'prone' }).character.spellcasting?.concentratingOn).toBe('Detect Magic');
  });

  it('petrified creatures are immune to Poisoned', () => {
    const stone = addCondition(mira(), { id: 'petrified' }).character;
    expect(addCondition(stone, { id: 'poisoned' }).events[0].type).toBe('warning');
  });

  it('removes conditions; Unconscious leaves you Prone', () => {
    const poisoned = addCondition(mira(), { id: 'poisoned' }).character;
    const cured = removeCondition(poisoned, 'Poisoned');
    expect(cured.character.conditions).toEqual([]);
    expect(cured.events[0]).toEqual({ type: 'condition-removed', message: 'No longer Poisoned.' });
    expect(removeCondition(mira(), 'blinded').events[0].type).toBe('warning');
    const asleep = addCondition(mira(), { id: 'unconscious', source: 'Sleep' }).character;
    expect(ids(removeCondition(asleep, 'unconscious').character)).toEqual(['prone']);
    const brewed = addCondition(mira(), { id: 'Poison Mist' }).character;
    expect(removeCondition(brewed, 'poison mist').character.conditions).toEqual([]);
  });
});

describe('changeExhaustion (2024)', () => {
  it('changes the level and describes the penalties', () => {
    const r = changeExhaustion(mira(), 2);
    expect(r.character.exhaustion).toBe(2);
    expect(r.events[0]).toEqual({ type: 'exhaustion-changed', message: 'Exhaustion 0 → 2 (−4 to D20 Tests, −10 ft Speed)' });
    expect(changeExhaustion(r.character, -5).character.exhaustion).toBe(0);
    expect(changeExhaustion(mira(), -1).events[0].type).toBe('warning');
  });

  it('level 6 is death', () => {
    const r = changeExhaustion(mira({ exhaustion: 5 }), 1);
    expect(r.character.exhaustion).toBe(6);
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.character.hp.current).toBe(0);
    expect(r.events[0].type).toBe('died');
  });

  it('removing the Exhaustion condition clears every level', () => {
    expect(removeCondition(mira({ exhaustion: 3 }), 'exhaustion').character.exhaustion).toBe(0);
  });
});

describe('features', () => {
  it('finds features by fuzzy name', () => {
    expect(findFeature(mira(), 'arcane recovery')?.id).toBe('feat-arcane-recovery');
    expect(findFeature(mira(), 'Magic Initiate')?.id).toBe('feat-magic-initiate');
    expect(findFeature(mira(), 'fey')?.id).toBe('feat-fey-ancestry');
    expect(findFeature(mira(), 'Rage')).toBeUndefined();
  });

  it('spends and restores uses', () => {
    const used = useFeature(mira(), 'Arcane Recovery');
    expect(used.character.features[0].uses?.used).toBe(1);
    expect(used.events[0].type).toBe('feature-used');
    expect(useFeature(used.character, 'Arcane Recovery').events[0].type).toBe('warning');
    expect(useFeature(mira(), 'Fey Ancestry').events[0].type).toBe('warning');
    expect(useFeature(mira(), 'Nope').events[0].message).toBe('No feature named "Nope".');
    const restored = restoreFeature(mira(), 'magic initiate');
    expect(restored.character.features[1].uses?.used).toBe(0);
    expect(restored.events[0].type).toBe('feature-restored');
  });

  it('adds, updates and removes features', () => {
    const added = addFeature(mira(), { name: 'Boon of the Tides', source: 'boon', description: 'Breathe water.', uses: { max: 1, used: 0, recharge: 'dawn' } });
    expect(added.character.features).toHaveLength(4);
    const id = added.character.features[3].id;
    const updated = addFeature(added.character, { name: 'boon of the tides', source: 'boon', description: 'Breathe water and swim fast.' });
    expect(updated.character.features).toHaveLength(4);
    expect(updated.character.features[3]).toMatchObject({ id, description: 'Breathe water and swim fast.' });
    expect(removeFeature(updated.character, 'Boon of the Tides').character.features).toHaveLength(3);
  });

  it("keeps a feat and a trait of one name apart, and spends or restores the one with the uses", () => {
    const trait = { id: 't-luck', name: 'Lantern Luck', source: 'species' as const, description: 'Invented trait: reroll a 1.' };
    const withFeat = addFeature(mira({ features: [trait] }), { name: 'Lantern Luck', source: 'feat', description: 'Invented feat: luck points.', uses: { max: 3, used: 0, recharge: 'long' } });
    expect(withFeat.character.features.map((f) => [f.name, f.source, f.description])).toEqual([
      ['Lantern Luck', 'species', 'Invented trait: reroll a 1.'],
      ['Lantern Luck', 'feat', 'Invented feat: luck points.'],
    ]);
    expect(withFeat.events[0].message).toBe('Gained feature: Lantern Luck (3 uses, recharges on a Long Rest), beside Lantern Luck (species)');
    // A feat of the name again updates the feat; a trait of it, the trait.
    const feat = addFeature(withFeat.character, { name: 'lantern luck', source: 'feat', description: 'Invented feat, rewritten.' }).character;
    expect(feat.features.map((f) => f.description)).toEqual(['Invented trait: reroll a 1.', 'Invented feat, rewritten.']);
    const traitAgain = addFeature(withFeat.character, { name: 'Lantern Luck', source: 'species', description: 'Invented trait, rewritten.' }).character;
    expect(traitAgain.features.map((f) => f.description)).toEqual(['Invented trait, rewritten.', 'Invented feat: luck points.']);
    // Only feats are kept apart: a feature that isn't one, rewritten under another source, is still updated.
    const otherwise = addFeature(withFeat.character, { name: 'Lantern Luck', source: 'other', description: 'Invented trait, by the DM.' }).character;
    expect(otherwise.features.map((f) => [f.source, f.description])).toEqual([['other', 'Invented trait, by the DM.'], ['feat', 'Invented feat: luck points.']]);
    // By name, a use goes to the one with uses left, a restore to the one with uses spent.
    const spent = useFeature(withFeat.character, 'Lantern Luck');
    expect(spent.character.features.map((f) => f.uses?.used)).toEqual([undefined, 1]);
    // The trait has no uses to spend, so the result needs no word about it.
    expect(spent.events[0].message).toBe('Used Lantern Luck (2/3 left; recharges on a Long Rest)');
    expect(restoreFeature(spent.character, 'Lantern Luck').character.features.map((f) => f.uses?.used)).toEqual([undefined, 0]);
  });

  it('spends and restores the right one of two same-named features with uses (a Repeatable feat taken twice)', () => {
    const taking = (id: string, used: number) => ({ id, name: 'Wick Tender', source: 'feat' as const, description: '', uses: { max: 1, used, recharge: 'long' as const } });
    const c = mira({ features: [taking('first', 1), taking('second', 0)] });
    const spent = useFeature(c, 'Wick Tender');
    expect(spent.character.features.map((f) => f.uses?.used)).toEqual([1, 1]);
    // Nothing tells two such takings apart, so the result names neither.
    expect(spent.events[0].message).toBe('Used Wick Tender (0/1 left; recharges on a Long Rest)');
    expect(restoreFeature(c, 'Wick Tender').character.features.map((f) => f.uses?.used)).toEqual([0, 0]);
  });

  it('picks one of two same-named features with uses by the amount, or by the source or source name in parentheses after the name', () => {
    const trait = { id: 't-luck', name: 'Lantern Luck', source: 'species' as const, sourceName: 'Mothkin', description: 'Invented trait.', uses: { max: 1, used: 0, recharge: 'short' as const } };
    const feat = { id: 'f-luck', name: 'Lantern Luck', source: 'feat' as const, sourceName: 'Ability Score Improvement (Fighter 4)', description: 'Invented feat.', uses: { max: 3, used: 0, recharge: 'long' as const } };
    const c = mira({ features: [trait, feat] });
    const usedOf = (x: Character) => x.features.map((f) => f.uses?.used);
    // By the name alone: the first whose uses cover the amount; the result says which, and how to name the other.
    const one = useFeature(c, 'Lantern Luck');
    expect(usedOf(one.character)).toEqual([1, 0]);
    expect(one.events[0].message).toBe(
      'Used Lantern Luck (Mothkin) (0/1 left; recharges on a Short or Long Rest). Another Lantern Luck is on the sheet: to use it, name it "Lantern Luck (Ability Score Improvement (Fighter 4))".',
    );
    expect(usedOf(useFeature(c, 'Lantern Luck', 2).character)).toEqual([0, 2]);
    expect(usedOf(useFeature(one.character, 'Lantern Luck', 2).character)).toEqual([1, 2]);
    // Named by its source, its source name or that name's first words: that one, with nothing more to say.
    const byFeat = useFeature(c, 'Lantern Luck (feat)');
    expect(usedOf(byFeat.character)).toEqual([0, 1]);
    expect(byFeat.events[0].message).toBe('Used Lantern Luck (2/3 left; recharges on a Long Rest)');
    expect(usedOf(useFeature(c, 'lantern luck (mothkin)').character)).toEqual([1, 0]);
    expect(usedOf(useFeature(c, 'Lantern Luck (Ability Score Improvement (Fighter 4))').character)).toEqual([0, 1]);
    expect(usedOf(useFeature(c, 'Lantern Luck (Ability Score Improvement)').character)).toEqual([0, 1]);
    expect(useFeature(c, 'Lantern Luck (Abil)').events[0].message).toBe('No feature named "Lantern Luck (Abil)".');
    expect(useFeature(c, 'Lantern Luck (Halfling)').events[0].message).toBe('No feature named "Lantern Luck (Halfling)".');
    // A restore: the first with as many uses spent, else any spent; by a name in parentheses too.
    const spent = mira({ features: [{ ...trait, uses: { ...trait.uses, used: 1 } }, { ...feat, uses: { ...feat.uses, used: 2 } }] });
    expect(usedOf(restoreFeature(spent, 'Lantern Luck', 2).character)).toEqual([1, 0]);
    const back = restoreFeature(spent, 'Lantern Luck', 1);
    expect(usedOf(back.character)).toEqual([0, 2]);
    expect(back.events[0].message).toBe(
      'Lantern Luck (Mothkin): regained 1 use (1/1). Another Lantern Luck is on the sheet: to restore it, name it "Lantern Luck (Ability Score Improvement (Fighter 4))".',
    );
    expect(usedOf(restoreFeature(spent, 'Lantern Luck (feat)', 1).character)).toEqual([1, 1]);
    expect(usedOf(restoreFeature(spent, 'Lantern Luck (feat)').character)).toEqual([1, 0]);
    // Neither covers the amount: a use is refused for the one with uses left, a restore gives what one has spent.
    const low = mira({ features: [{ ...trait, uses: { ...trait.uses, used: 1 } }, { ...feat, uses: { ...feat.uses, used: 2 } }] });
    expect(useFeature(low, 'Lantern Luck', 2).events[0].message).toBe('Not enough uses of Lantern Luck: 1 of 3 left, 2 needed.');
    const featSpent = mira({ features: [trait, { ...feat, uses: { ...feat.uses, used: 1 } }] });
    expect(usedOf(restoreFeature(featSpent, 'Lantern Luck', 2).character)).toEqual([0, 0]);
    // A source name given whole wins over one it starts.
    const lineage = { ...trait, id: 't-lineage', sourceName: 'Mothkin Lineage', uses: { ...trait.uses } };
    const both = mira({ features: [lineage, trait] });
    expect(usedOf(useFeature(both, 'Lantern Luck (Mothkin)').character)).toEqual([0, 1]);
    // A feature whose own name ends in parentheses is found by that name.
    const own = mira({ features: [{ ...trait, id: 'x', name: 'Darkvision (Transformation)' }] });
    expect(useFeature(own, 'Darkvision (Transformation)').character.features[0].uses?.used).toBe(1);
  });

  it('labels the one changed when a name in parentheses fits several with uses, as the bare name does', () => {
    // A Repeatable feat taken twice (SRD 5.2.1 Feats: Repeatable), named by its source or its source name's first words.
    const taking = (id: string, level: number) => ({ id, name: 'Wick Tender', source: 'feat' as const, sourceName: `Ability Score Improvement (Fighter ${level})`, description: '', uses: { max: 3, used: 0, recharge: 'long' as const } });
    const c = mira({ features: [taking('first', 4), taking('second', 8)] });
    const bySource = useFeature(c, 'Wick Tender (feat)');
    const byWords = useFeature(c, 'Wick Tender (Ability Score Improvement)');
    for (const spent of [bySource, byWords]) {
      expect(spent.character.features.map((f) => f.uses?.used)).toEqual([1, 0]);
      expect(spent.events[0].message).toBe(
        'Used Wick Tender (Ability Score Improvement (Fighter 4)) (2/3 left; recharges on a Long Rest). Another Wick Tender is on the sheet: to use it, name it "Wick Tender (Ability Score Improvement (Fighter 8))".',
      );
    }
    expect(restoreFeature(useFeature(c, 'Wick Tender (feat)').character, 'Wick Tender (feat)').events[0].message).toBe(
      'Wick Tender (Ability Score Improvement (Fighter 4)): regained 1 use (3/3). Another Wick Tender is on the sheet: to restore it, name it "Wick Tender (Ability Score Improvement (Fighter 8))".',
    );
    // Two classes' features of one name (a multiclass hero's Channel Divinity), named by their source.
    const channel = (id: string, sourceName: string) => ({ id, name: 'Channel Divinity', source: 'class' as const, sourceName, description: '', uses: { max: 2, used: 0, recharge: 'short' as const } });
    expect(useFeature(mira({ features: [channel('cleric', 'Cleric 2'), channel('paladin', 'Paladin 3')] }), 'Channel Divinity (class)').events[0].message).toBe(
      'Used Channel Divinity (Cleric 2) (1/2 left; recharges on a Short or Long Rest). Another Channel Divinity is on the sheet: to use it, name it "Channel Divinity (Paladin 3)".',
    );
    // Of those it fits only one has uses: the name picked it, whatever else of the name has uses (a trait's).
    const trait = { id: 't-wick', name: 'Wick Tender', source: 'species' as const, sourceName: 'Mothkin', description: '', uses: { max: 1, used: 0, recharge: 'short' as const } };
    const one = mira({ features: [{ ...taking('first', 4), uses: undefined }, taking('second', 8), trait] });
    expect(useFeature(one, 'Wick Tender (feat)').events[0].message).toBe('Used Wick Tender (2/3 left; recharges on a Long Rest)');
  });

  it("keeps where a rewritten feature came from, so the name a result gave still finds it", () => {
    const trait = { id: 't-luck', name: 'Lantern Luck', source: 'species' as const, sourceName: 'Mothkin', description: 'Invented trait.', uses: { max: 1, used: 0, recharge: 'short' as const } };
    const feat = { id: 'f-luck', name: 'Lantern Luck', source: 'feat' as const, sourceName: 'Granted in play', description: 'Invented feat.', uses: { max: 3, used: 0, recharge: 'long' as const } };
    // The DM's ruling on the trait (its tools name every entry "Granted in play").
    const ruled = addFeature(mira({ features: [trait, feat] }), { name: 'Lantern Luck', source: 'species', sourceName: 'Granted in play', description: 'A ruling.' }).character;
    expect(ruled.features.map((f) => [f.id, f.sourceName, f.description])).toEqual([
      ['t-luck', 'Mothkin', 'A ruling.'],
      ['f-luck', 'Granted in play', 'Invented feat.'],
    ]);
    expect(useFeature(ruled, 'Lantern Luck (Mothkin)').character.features.map((f) => f.uses?.used)).toEqual([1, 0]);
    expect(useFeature(ruled, 'Lantern Luck (Granted in play)').character.features.map((f) => f.uses?.used)).toEqual([0, 1]);
    // One with no source name takes the rewrite's.
    const bare = { id: 'x', name: 'Lantern Luck', source: 'species' as const, description: '' };
    expect(addFeature(mira({ features: [bare] }), { name: 'Lantern Luck', source: 'species', sourceName: 'Granted in play', description: 'A ruling.' }).character.features[0].sourceName).toBe('Granted in play');
  });

  it("keeps a feat apart only from a species trait or class feature: a boon's or background's entry of its name rewrites it, keeping the uses spent", () => {
    // SRD 5.2.1 Epic Boon feats: the level-up stores one as a feat; the DM's entry for it as a boon is the same feature.
    const boon = { id: 'f-fate', name: 'Boon of Fate', source: 'feat' as const, sourceName: 'Epic Boon (Fighter 19)', description: 'Boon text.', uses: { max: 1, used: 1, recharge: 'short' as const } };
    const rewritten = addFeature(mira({ features: [boon] }), { name: 'Boon of Fate', source: 'boon', description: 'By the DM.', uses: { max: 1, used: 0, recharge: 'short' } });
    expect(rewritten.events[0].message).toBe('Updated feature: Boon of Fate');
    expect(rewritten.character.features).toEqual([{ ...boon, source: 'boon', description: 'By the DM.' }]);
    // An Origin feat rewritten as its background's.
    const alert = { id: 'f-alert', name: 'Alert', source: 'feat' as const, sourceName: 'Sage (Origin feat)', description: 'Alert text.' };
    expect(addFeature(mira({ features: [alert] }), { name: 'Alert', source: 'background', description: 'By the DM.' }).character.features.map((f) => [f.id, f.description])).toEqual([['f-alert', 'By the DM.']]);
    // A feat beside a class feature of its name, and a species trait beside a feat: two features, either way round.
    const classFeature = { id: 'c-flame', name: 'Watchful Flame', source: 'class' as const, sourceName: 'Fighter 4', description: 'Invented class feature.' };
    expect(addFeature(mira({ features: [classFeature] }), { name: 'Watchful Flame', source: 'feat', description: 'Invented feat.' }).character.features.map((f) => f.source)).toEqual(['class', 'feat']);
    expect(addFeature(mira({ features: [alert] }), { name: 'Alert', source: 'species', description: 'Invented trait.' }).character.features.map((f) => f.source)).toEqual(['feat', 'species']);
    const subclassFeature = { ...classFeature, id: 's-flame', source: 'subclass' as const };
    expect(addFeature(mira({ features: [subclassFeature] }), { name: 'Watchful Flame', source: 'feat', description: 'Invented feat.' }).character.features.map((f) => f.source)).toEqual(['subclass', 'feat']);
    // The boon the DM stored, rewritten as a feat: still the one feature.
    expect(addFeature(rewritten.character, { name: 'Boon of Fate', source: 'feat', description: 'As a feat.' }).character.features.map((f) => [f.id, f.source])).toEqual([['f-fate', 'feat']]);
    // A rewrite keeps the uses spent, no more than its new maximum (a number the DM ruled: progression.test.ts).
    const spentAll = mira({ features: [{ ...boon, uses: { max: 3, used: 3, recharge: 'long' as const } }] });
    expect(addFeature(spentAll, { name: 'Boon of Fate', source: 'feat', description: '', uses: { max: 2, used: 0, recharge: 'long' } }).character.features[0].uses).toEqual({ max: 2, used: 2, recharge: 'long', ruled: true });
    expect(addFeature(spentAll, { name: 'Boon of Fate', source: 'feat', description: 'No uses given.' }).character.features[0].uses).toEqual({ max: 3, used: 3, recharge: 'long' });
  });

  it('labels a feature by what tells it from others of its name (featureLabel)', () => {
    const f = (id: string, source: Feature['source'], sourceName?: string): Feature => ({ id, name: 'Lantern Luck', source, description: '', ...(sourceName ? { sourceName } : {}) });
    expect(featureLabel(f('a', 'feat', 'Granted in play'), [f('a', 'feat', 'Granted in play')])).toBe('Lantern Luck');
    expect(featureLabel(f('a', 'species', 'Mothkin'), [f('a', 'species', 'Mothkin'), f('b', 'feat', 'Granted in play')])).toBe('Lantern Luck (Mothkin)');
    expect(featureLabel(f('a', 'species', 'Granted in play'), [f('a', 'species', 'Granted in play'), f('b', 'feat', 'Granted in play')])).toBe('Lantern Luck (species)');
    expect(featureLabel(f('a', 'feat'), [f('a', 'feat'), f('b', 'feat')])).toBe('Lantern Luck');
  });

  it('Heroic Inspiration: only one at a time', () => {
    expect(setHeroicInspiration(mira(), true).events[0].type).toBe('warning');
    const spent = setHeroicInspiration(mira(), false);
    expect(spent.character.heroicInspiration).toBe(false);
    expect(setHeroicInspiration(spent.character, true).character.heroicInspiration).toBe(true);
  });
});

describe('changeAbilityScore (SRD 5.2.1 Ability Score Improvement; Hit Points: Constitution changes)', () => {
  it('raises a score up to the cap and a Constitution modifier change moves HP as though from level 1', () => {
    // Wizard 3: CON 13 (+1) → 15 (+2): +1 HP per level = +3.
    const r = changeAbilityScore(mira(), 'con', 2);
    expect(r.character.abilityScores.con).toBe(15);
    expect(r.character.hp).toMatchObject({ max: 20, current: 15 });
    expect(r.events.map((e) => e.message)).toEqual(['Constitution 13 → 15', 'HP maximum 17 → 20 (Constitution modifier +1 per level)']);
    const capped = changeAbilityScore(mira({ abilityScores: { ...mira().abilityScores, int: 19 } }), 'int', 2);
    expect(capped.character.abilityScores.int).toBe(20);
    expect(capped.events.some((e) => e.type === 'warning' && e.message === 'Intelligence is capped at 20.')).toBe(true);
  });

  it('never lowers a score above the cap with an increase, and stays within 1–30', () => {
    const strong = mira({ abilityScores: { ...mira().abilityScores, str: 21 } });
    expect(changeAbilityScore(strong, 'str', 1).events[0]).toEqual({ type: 'warning', message: 'Strength is already 21 (the most it can reach here is 20).' });
    expect(changeAbilityScore(strong, 'str', 12, 30).character.abilityScores.str).toBe(30);
    expect(changeAbilityScore(strong, 'str', 5, 99).character.abilityScores.str).toBe(26);
    expect(changeAbilityScore(mira(), 'str', -10).character.abilityScores.str).toBe(1);
  });

  it('lowers HP with Constitution but never below 1, and leaves a downed hero at 0', () => {
    const r = changeAbilityScore(mira({ hp: { max: 17, current: 2, temp: 0 } }), 'con', -4);
    // CON 13 (+1) → 9 (−1): −2 per level = −6.
    expect(r.character.hp).toMatchObject({ max: 11, current: 1 });
    const down = changeAbilityScore(mira({ hp: { max: 17, current: 0, temp: 0 } }), 'con', -4);
    expect(down.character.hp.current).toBe(0);
  });
});

describe('inventory', () => {
  it('finds items by fuzzy name', () => {
    expect(findItem(mira(), 'potion')?.id).toBe('item-healing');
    expect(findItem(mira(), 'daggers')?.id).toBe('item-dagger');
    expect(findItem(mira(), 'rope')).toBeUndefined();
  });

  it('stacks plain items but not magic ones', () => {
    const more = addItem(mira(), { name: 'dagger', quantity: 1 });
    expect(more.character.inventory.find((i) => i.id === 'item-dagger')?.quantity).toBe(3);
    expect(more.events[0].message).toBe('Added 1 × Dagger (now 3)');
    const magic = addItem(mira(), { name: 'Dagger', quantity: 1, magic: true });
    expect(magic.character.inventory).toHaveLength(6);
    expect(addItem(mira(), { name: 'Rope', quantity: 1 }).character.inventory.at(-1)).toMatchObject({ name: 'Rope', quantity: 1 });
  });

  it('removes some or all of an item and warns on problems', () => {
    const one = removeItem(mira(), 'Potion of Healing', 1);
    expect(one.character.inventory.find((i) => i.id === 'item-healing')?.quantity).toBe(1);
    expect(one.events[0].message).toBe('Removed 1 × Potion of Healing (1 left)');
    expect(removeItem(mira(), 'Potion of Healing').character.inventory.some((i) => i.id === 'item-healing')).toBe(false);
    const tooMany = removeItem(mira(), 'Potion of Healing', 3);
    expect(tooMany.events[0].type).toBe('warning');
    expect(tooMany.character).toEqual(mira());
    expect(removeItem(mira(), 'Bag of Holding').events[0].type).toBe('warning');
  });

  it('updates items and enforces the three-item attunement limit', () => {
    const equipped = updateItem(mira(), 'spellbook', { equipped: true });
    expect(equipped.character.inventory[1].equipped).toBe(true);
    expect(updateItem(mira(), 'robe', { quantity: 0 }).character.inventory.some((i) => i.name === 'Robe')).toBe(false);
    const attuned = mira({
      inventory: [
        ...mira().inventory,
        { id: 'a1', name: 'Ring A', quantity: 1, attuned: true, magic: true },
        { id: 'a2', name: 'Ring B', quantity: 1, attuned: true, magic: true },
        { id: 'a3', name: 'Amulet C', quantity: 1, attuned: true, magic: true },
      ],
    });
    expect(updateItem(attuned, 'Potion of Healing', { attuned: true }).events[0].type).toBe('warning');
  });
});

describe('inventory changes keep the AC in step (SRD 5.2.1 Armor; Ring of Protection)', () => {
  const fighter = mira({
    armorTraining: ['Light armor', 'Medium armor', 'Heavy armor', 'Shields'],
    inventory: [
      ...mira().inventory,
      { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor' },
      { id: 'sh', name: 'Shield', quantity: 1, weight: 6, category: 'shield' },
    ],
  });
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);

  it('equipping armor and a Shield, attuning a Ring of Protection and dropping the Shield', () => {
    const armored = updateItem(fighter, 'Chain Mail', { equipped: true });
    expect(armored.character).toMatchObject({ armorClass: 16, acFormula: 'Chain Mail 16' });
    expect(messages(armored)).toEqual(['Updated Chain Mail: equipped', 'AC 12 → 16 (Chain Mail 16)']);
    const shielded = updateItem(armored.character, 'Shield', { equipped: true });
    expect(shielded.character.armorClass).toBe(18);
    const ring = addItem(shielded.character, { name: 'Ring of Protection', quantity: 1, magic: true, category: 'magic-item', equipped: true });
    expect(ring.character.armorClass).toBe(18); // not attuned yet
    const attuned = updateItem(ring.character, 'Ring of Protection', { attuned: true });
    expect(attuned.character.armorClass).toBe(19);
    const dropped = removeItem(attuned.character, 'Shield');
    expect(dropped.character).toMatchObject({ armorClass: 17, acFormula: 'Chain Mail 16 + Ring of Protection 1' });
    expect(updateItem(dropped.character, 'Chain Mail', { quantity: 0 }).character.armorClass).toBe(13);
  });

  it('keeps an AC set by hand (Mage Armor) and warns with the computed value', () => {
    const mageArmor = { ...fighter, armorClass: 15 };
    const r = updateItem(mageArmor, 'Shield', { equipped: true });
    expect(r.character.armorClass).toBe(15);
    expect(r.events.at(-1)?.type).toBe('warning');
    expect(r.events.at(-1)?.message).toMatch(/^AC kept at 15: .*now give AC 14/);
  });

  it("leaves the AC alone for items that don't affect it", () => {
    const r = updateItem(fighter, 'Robe', { equipped: true });
    expect(r.character.armorClass).toBe(12);
    expect(messages(r)).toEqual(['Updated Robe: equipped']);
    expect(messages(removeItem(fighter, 'Potion of Healing', 1))).toEqual(['Removed 1 × Potion of Healing (1 left)']);
  });
});

describe('currency', () => {
  it('totals wealth in gp', () => {
    expect(totalGp(mira().currency)).toBe(26.14);
    expect(totalGp({ cp: 0, sp: 0, ep: 2, gp: 1, pp: 1 })).toBe(12);
    expect(formatCurrency(mira().currency)).toBe('23 gp, 30 sp, 14 cp');
  });

  it('adds coins', () => {
    const r = changeCurrency(mira(), { gp: 10 });
    expect(r.character.currency.gp).toBe(33);
    expect(r.events[0].type).toBe('currency-changed');
  });

  it('pays with smaller coins when short (25 gp from 23 gp + 30 sp)', () => {
    const r = changeCurrency(mira(), { gp: -25 });
    expect(r.character.currency).toEqual({ cp: 14, sp: 10, ep: 0, gp: 0, pp: 0 });
    expect(totalGp(r.character.currency)).toBeCloseTo(1.14, 10);
  });

  it('makes change from larger coins', () => {
    const purse = (currency: Character['currency']) => mira({ currency });
    expect(changeCurrency(purse({ cp: 0, sp: 0, ep: 0, gp: 1, pp: 0 }), { cp: -5 }).character.currency).toEqual({ cp: 5, sp: 9, ep: 0, gp: 0, pp: 0 });
    expect(changeCurrency(purse({ cp: 0, sp: 0, ep: 0, gp: 0, pp: 1 }), { gp: -3 }).character.currency).toEqual({ cp: 0, sp: 0, ep: 0, gp: 7, pp: 0 });
    expect(changeCurrency(purse({ cp: 0, sp: 0, ep: 3, gp: 0, pp: 0 }), { gp: -1 }).character.currency).toEqual({ cp: 0, sp: 0, ep: 1, gp: 0, pp: 0 });
    expect(changeCurrency(purse({ cp: 0, sp: 3, ep: 0, gp: 2, pp: 0 }), { sp: -5 }).character.currency).toEqual({ cp: 0, sp: 8, ep: 0, gp: 1, pp: 0 });
  });

  it('refuses to overspend and changes nothing', () => {
    const c = mira();
    const r = changeCurrency(c, { gp: -30 });
    expect(r.character).toBe(c);
    expect(r.events[0].type).toBe('warning');
    expect(r.events[0].message).toMatch(/Can't afford 30 gp/);
  });

  it('applies gains before costs in one change', () => {
    const r = changeCurrency(mira({ currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 } }), { gp: 5, sp: -20 });
    expect(r.character.currency).toEqual({ cp: 0, sp: 0, ep: 0, gp: 3, pp: 0 });
  });
});

describe('gainXp', () => {
  it('adds XP and reports when a level is available', () => {
    const some = gainXp(mira(), 300);
    expect(some.character.xp).toBe(1200);
    expect(some.levelUpAvailable).toBe(false);
    const enough = gainXp(mira(), 1800);
    expect(enough.character.xp).toBe(2700);
    expect(enough.levelUpAvailable).toBe(true);
    expect(enough.events[0].message).toMatch(/level 4/);
    expect(gainXp(mira(), -5000).character.xp).toBe(0);
  });
});

describe('spells and concentration', () => {
  it('adds and updates spells', () => {
    const added = addSpell(mira(), { name: 'Fireball', level: 3, prepared: true, concentration: false });
    expect(added.character.spellcasting?.spells.at(-1)).toMatchObject({ name: 'Fireball', level: 3 });
    const updated = addSpell(added.character, { name: 'fireball', level: 3, prepared: false });
    expect(updated.character.spellcasting?.spells.filter((s) => s.name.toLowerCase() === 'fireball')).toHaveLength(1);
    const fighter = mira({ spellcasting: undefined, classes: [] });
    expect(addSpell(fighter, { name: 'Light', level: 0, prepared: true }).character.spellcasting?.ability).toBe('int');
  });

  it('removing a spell ends concentration on it', () => {
    const focused = setConcentration(mira(), 'detect magic').character;
    expect(focused.spellcasting?.concentratingOn).toBe('Detect Magic');
    const removed = removeSpell(focused, 'Detect Magic');
    expect(removed.character.spellcasting?.concentratingOn).toBeNull();
    expect(removed.character.spellcasting?.spells.some((s) => s.name === 'Detect Magic')).toBe(false);
  });

  it('starting a new concentration effect ends the previous one', () => {
    const first = setConcentration(mira(), 'Detect Magic').character;
    const second = setConcentration(first, 'Sleep');
    expect(second.character.spellcasting?.concentratingOn).toBe('Sleep');
    expect(second.events.map((e) => e.type)).toEqual(['condition-removed', 'condition-added']);
    expect(setConcentration(second.character, null).character.spellcasting?.concentratingOn).toBeNull();
    const stunned = addCondition(mira(), { id: 'stunned' }).character;
    expect(setConcentration(stunned, 'Sleep').events[0].type).toBe('warning');
  });
});

describe('damage defenses (resistance, immunity, vulnerability) and condition immunity', () => {
  it('halves resisted damage, rounding down, and explains the adjustment', () => {
    const c = sampleCharacter({ hp: { max: 17, current: 17, temp: 0 }, damageResistances: ['Fire'] });
    const r = applyDamage(c, 9, { damageType: 'fire' });
    expect(r.character.hp.current).toBe(13);
    expect(r.events[0].message).toMatch(/Resistance to fire halves 9 → 4/);
  });

  it('ignores damage the character is immune to', () => {
    const c = sampleCharacter({ hp: { max: 17, current: 17, temp: 0 }, damageImmunities: ['poison'] });
    const r = applyDamage(c, 12, { damageType: 'Poison' });
    expect(r.character.hp.current).toBe(17);
    expect(r.events[0].type).toBe('warning');
  });

  it('doubles damage for vulnerabilities, after resistance', () => {
    const vulnerable = sampleCharacter({ hp: { max: 17, current: 17, temp: 0 }, damageVulnerabilities: ['cold'] });
    expect(applyDamage(vulnerable, 5, { damageType: 'cold' }).character.hp.current).toBe(7);
    const both = sampleCharacter({ hp: { max: 17, current: 17, temp: 0 }, damageResistances: ['cold'], damageVulnerabilities: ['cold'] });
    expect(applyDamage(both, 5, { damageType: 'cold' }).character.hp.current).toBe(13);
  });

  it('leaves untyped damage and applyDefenses:false untouched', () => {
    const c = sampleCharacter({ hp: { max: 17, current: 17, temp: 0 }, damageResistances: ['fire'] });
    expect(applyDamage(c, 6).character.hp.current).toBe(11);
    expect(applyDamage(c, 6, { damageType: 'fire', applyDefenses: false }).character.hp.current).toBe(11);
  });

  it('refuses conditions the character is immune to', () => {
    const c = sampleCharacter({ conditionImmunities: ['Poisoned'] });
    const r = addCondition(c, { id: 'poisoned' });
    expect(r.character.conditions).toHaveLength(0);
    expect(r.events[0].type).toBe('warning');
  });
});
