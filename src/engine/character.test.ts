import { describe, expect, it } from 'vitest';
import type { Character, Feature } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import {
  addCondition,
  addFeature,
  addItem,
  addSpell,
  adjustHpMax,
  applyDamage,
  applyDrainingDamage,
  applyHealing,
  changeAbilityScore,
  changeInitiativeBonus,
  damageTaken,
  drainProblem,
  endHpMaxAdjustments,
  endHpMaxAdjustmentsWhere,
  hpMaxAdjustmentLabel,
  hpMaxAdjustments,
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
import { levelUp } from './progression';

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

describe("addFeature: what a feat joining the sheet brings (the DM's features_add)", () => {
  const feat = (name: string, source: Feature['source'] = 'feat'): Omit<Feature, 'id'> => ({ name, source, description: 'By the DM.' });

  it('adds the Proficiency Bonus to Initiative for the first Alert feat (SRD 5.2.1 Alert: Initiative Proficiency)', () => {
    // Wizard 3, DEX 14: Initiative +2 → +4.
    const r = addFeature(mira(), feat('Alert'));
    expect(r.character.initiativeBonusExtra).toBe(2);
    expect(r.events.map((e) => e.message)).toEqual(['Gained feature: Alert', 'Initiative +2 → +4 (Alert: Proficiency Bonus +2)']);
    // At Wizard 9 the bonus is +4, beside one the sheet has from elsewhere.
    const ninth = mira({ classes: [{ ...mira().classes[0], level: 9 }], initiativeBonusExtra: 1 });
    expect(addFeature(ninth, feat('Alert')).character.initiativeBonusExtra).toBe(1 + 4);
    // The DM's entry on neither side of the feat line is the feat too (a boon, a background's, an item's, homebrew, other).
    for (const source of ['boon', 'background', 'item', 'homebrew', 'other'] as const) {
      expect(addFeature(mira(), feat('Alert', source)).character.initiativeBonusExtra, source).toBe(2);
    }
    // A species trait or class or subclass feature of the name isn't the feat (isAlertFeat): nothing, and no line.
    for (const source of ['species', 'class', 'subclass'] as const) {
      const other = addFeature(mira(), feat('Alert', source));
      expect(other.character.initiativeBonusExtra ?? 0, source).toBe(0);
      expect(other.events, source).toHaveLength(1);
    }
    // Beside a species trait of its name, the feat brings it all the same.
    expect(addFeature(mira({ features: [{ id: 't', ...feat('Alert', 'species') }] }), feat('Alert')).character.initiativeBonusExtra).toBe(2);
  });

  it('keeps the Alert or Tough feat the feat: a species trait or class feature of its name joins beside it, so its numbers are neither left nor paid twice', () => {
    const named = (c: Character, name: string) => c.features.filter((f) => f.name === name).map((f) => f.source);
    const numbers = (c: Character) => [c.hp.max, c.initiativeBonusExtra ?? 0];
    for (const name of ['Alert', 'Tough']) {
      for (const neither of ['boon', 'background', 'other'] as const) {
        // Recorded on neither side of the feat line: the feat, with its numbers.
        const recorded = addFeature(mira(), feat(name, neither)).character;
        expect(numbers(recorded), `${name} ${neither}`).not.toEqual(numbers(mira()));
        for (const trait of ['species', 'class', 'subclass'] as const) {
          const beside = addFeature(recorded, feat(name, trait)).character;
          expect(named(beside, name), `${name} ${neither} ${trait}`).toEqual([neither, trait]);
          expect(numbers(beside), `${name} ${neither} ${trait}`).toEqual(numbers(recorded));
          // The feat recorded again: an update of the one the sheet holds, nothing paid a second time.
          const again = addFeature(beside, feat(name)).character;
          expect(named(again, name), `${name} ${neither} ${trait} again`).toEqual(['feat', trait]);
          expect(numbers(again), `${name} ${neither} ${trait} again`).toEqual(numbers(recorded));
        }
      }
    }
    // A feature with no numbers still moves where the DM says: a boon's entry rewritten as a species trait.
    const luck = addFeature(mira(), feat('Lantern Luck', 'boon')).character;
    expect(named(addFeature(luck, feat('Lantern Luck', 'species')).character, 'Lantern Luck')).toEqual(['species']);
  });

  it("joins a transformation's power of its name, never rewrites it, and brings the bonus a trait rewritten into the feat gets", () => {
    // The transformation's own: the DM's entry joins beside it (its end takes only the power), with the feat's bonus.
    const power = { id: 'p', name: 'Alert', source: 'transformation' as const, sourceName: 'Wolf Blood', description: 'Invented: keen senses.' };
    const beside = addFeature(mira({ features: [power] }), feat('Alert'));
    expect(beside.character.features.map((f) => [f.id === 'p' ? 'power' : 'new', f.source])).toEqual([['power', 'transformation'], ['new', 'feat']]);
    expect(beside.character.initiativeBonusExtra).toBe(2);
    for (const source of ['boon', 'other'] as const) expect(addFeature(mira({ features: [power] }), feat('Alert', source)).character.features, source).toHaveLength(2);
    // A boon's or other entry rewrites a class feature named Alert (featOrTrait): the sheet holds the Alert feat now.
    const classAlert = { id: 'c', ...feat('Alert', 'class'), sourceName: 'Fighter 4' };
    const rewritten = addFeature(mira({ features: [classAlert] }), feat('Alert', 'other'));
    expect(rewritten.character.features).toEqual([expect.objectContaining({ id: 'c', source: 'other' })]);
    expect(rewritten.character.initiativeBonusExtra).toBe(2);
    expect(rewritten.events.map((e) => e.message)).toEqual(['Updated feature: Alert', 'Initiative +2 → +4 (Alert: Proficiency Bonus +2)']);
  });

  it("adds Tough's twice-the-level Hit Points for the Tough feat, current HP with them (the engine's Tough rule)", () => {
    // Wizard 3, HP 12 of 17: +6.
    const r = addFeature(mira(), feat('Tough'));
    expect(r.character.hp).toEqual({ max: 23, current: 18, temp: 0 });
    expect(r.events.map((e) => e.message)).toEqual(['Gained feature: Tough', 'HP maximum 17 → 23 (Tough: twice your level, 3)']);
    // The DM's entry on neither side of the feat line is the feat too; a species trait or class feature of the name isn't.
    expect(addFeature(mira(), feat('Tough', 'boon')).character.hp.max).toBe(23);
    for (const source of ['species', 'class', 'subclass'] as const) expect(addFeature(mira(), feat('Tough', source)).character.hp.max, source).toBe(17);
    // The feat beside a species trait named Tough, which isn't the feat: the feat's own Hit Points.
    expect(addFeature(mira({ features: [{ id: 'st', ...feat('Tough', 'species') }] }), feat('Tough')).character.hp.max).toBe(23);
    // A hero at 0 HP gains the maximum and stays at 0, as for a Constitution change.
    expect(addFeature(dying(), feat('Tough')).character.hp).toMatchObject({ max: 23, current: 0 });
  });

  it('adds nothing when it updates a feature of the name, or joins one the engine already counts', () => {
    const alert = { id: 'a', ...feat('Alert'), sourceName: 'Criminal (Origin feat)' };
    const tough = { id: 't', ...feat('Tough'), sourceName: 'Ability Score Improvement (Wizard 4)' };
    // The feat on the sheet, sent again (the DM recording a pick the level-up counted): an update.
    expect(addFeature(mira({ features: [alert], initiativeBonusExtra: 2 }), feat('Alert')).character.initiativeBonusExtra).toBe(2);
    expect(addFeature(mira({ features: [tough] }), feat('Tough')).character.hp.max).toBe(17);
    expect(addFeature(mira({ features: [tough] }), feat('Tough', 'homebrew')).character.hp.max).toBe(17);
    // Beside the feat, a class feature of its name (not the feat): nothing more.
    expect(addFeature(mira({ features: [alert], initiativeBonusExtra: 2 }), feat('Alert', 'class')).character.initiativeBonusExtra).toBe(2);
    expect(addFeature(mira({ features: [tough] }), feat('Tough', 'class')).character.hp.max).toBe(17);
    // Sent twice in one call: the second is an update.
    expect(addFeature(addFeature(mira(), feat('Tough')).character, feat('Tough')).character.hp.max).toBe(23);
    // Any other feature changes neither.
    const other = addFeature(mira(), feat('Savage Attacker')).character;
    expect([other.hp.max, other.initiativeBonusExtra ?? 0]).toEqual([17, 0]);
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

describe('Hit Point maximum adjustments (SRD 5.2.1)', () => {
  const aid = { name: 'Aid', change: 5, ends: 'long-rest' } as const;
  const drain = (change: number, name = 'Life Drain') => ({ name, change, ends: 'long-rest' }) as const;
  /** Mira at 30/30 (or `current`), for a Wraith's 21-point Life Drain. */
  const hardy = (current = 30, overrides: Partial<Character> = {}) => mira({ hp: { max: 30, current, temp: 0 }, ...overrides });
  const message = (r: { events: { message: string }[] }) => r.events.map((e) => e.message).join(' | ');

  it('Aid raises the maximum and current HP by 5 until a Long Rest; temporary HP stay (srd:spell:aid)', () => {
    // "Each target's Hit Point maximum and current Hit Points increase by 5 for the duration." Temporary Hit Points:
    // "Because Temporary Hit Points aren't Hit Points, a creature can be at full Hit Points and receive Temporary Hit Points."
    const r = adjustHpMax(mira({ hp: { max: 17, current: 12, temp: 3 } }), aid);
    expect(r.character.hp).toEqual({ max: 22, current: 17, temp: 3 });
    expect(r.character.hpMaxAdjustments).toEqual([{ name: 'Aid', amount: 5, ends: 'long-rest' }]);
    expect(r.events).toEqual([{ type: 'hp-changed', message: 'HP maximum 17 → 22, HP 12 → 17 (Aid +5, until a Long Rest)' }]);
    expect(hpMaxAdjustmentLabel(r.character.hpMaxAdjustments![0])).toBe('Aid +5 (until a Long Rest)');
  });

  it('Aid wakes a dying hero: Unconscious ends, Prone stays, death saves reset (srd:rule:...-falling-unconscious, -death-saving-throws)', () => {
    // Falling Unconscious: "until you regain any Hit Points"; Death Saving Throws: "The number of both is reset to zero
    // when you regain any Hit Points".
    const down = applyDamage(dying(), 1).character;
    expect(down.deathSaves.failures).toBe(1);
    const r = adjustHpMax(down, aid);
    expect(r.character.hp).toEqual({ max: 22, current: 5, temp: 0 });
    expect(ids(r.character)).toEqual(['prone']);
    expect(r.character.deathSaves).toEqual({ successes: 0, failures: 0, stable: false, dead: false });
    expect(r.events).toEqual([{ type: 'revived', message: 'HP maximum 17 → 22, HP 0 → 5 (Aid +5, until a Long Rest) — conscious again, but still Prone.' }]);
  });

  it('refuses the dead and a sheet without a maximum (srd:rule:dead: "A dead creature has no Hit Points")', () => {
    const dead = mira({ hp: { max: 17, current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } });
    const r = adjustHpMax(dead, aid);
    expect(r.character).toBe(dead);
    expect(r.events[0].type).toBe('warning');
    const blank = mira({ hp: { max: 0, current: 0, temp: 0 } });
    expect(adjustHpMax(blank, aid).character).toBe(blank);
    const hero = mira();
    for (const bad of [{ ...aid, name: '  ' }, { ...aid, change: 0 }]) {
      const refused = adjustHpMax(hero, bad);
      expect(refused.character).toBe(hero);
      expect(refused.events[0].type).toBe('warning');
    }
  });

  it("the same spell doesn't combine; a stronger casting replaces it, and different spells add (srd:rule:casting-spells-effects-combining-spell-effects)", () => {
    // "the effects of the same spell cast multiple times don't combine. Instead, the most potent effect … applies";
    // "The effects of different spells add together".
    const aided = adjustHpMax(mira(), aid).character;
    const again = adjustHpMax(aided, aid);
    expect(again.character).toBe(aided);
    expect(again.events[0]).toMatchObject({ type: 'warning', message: expect.stringContaining("Aid +5 already applies: the same spell's effects don't combine") });
    expect(adjustHpMax(aided, { ...aid, name: 'Aid (2nd level)' }).character).toBe(aided);
    const upcast = adjustHpMax(aided, { name: 'Aid (3rd level)', change: 10, ends: 'long-rest' });
    expect(upcast.character.hp).toEqual({ max: 27, current: 22, temp: 0 });
    expect(upcast.character.hpMaxAdjustments).toEqual([{ name: 'Aid (3rd level)', amount: 10, ends: 'long-rest' }]);
    expect(message(upcast)).toBe('HP maximum 22 → 27, HP 17 → 22 (Aid (3rd level) +10 replaces Aid +5, until a Long Rest)');
    // srd:spell:heroes-feast: "Its Hit Point maximum also increases by 2d10, and it gains the same number of Hit Points."
    const feast = adjustHpMax(upcast.character, { name: "Heroes' Feast", change: 12, ends: 'when-ended' });
    expect(feast.character.hp).toEqual({ max: 39, current: 34, temp: 0 });
    expect(hpMaxAdjustments(feast.character).map(hpMaxAdjustmentLabel)).toEqual(['Aid (3rd level) +10 (until a Long Rest)', "Heroes' Feast +12 (until ended)"]);
  });

  it("a Wraith's Life Drain lowers the maximum, and current HP only to fit; drains add up (srd:monster:wraith)", () => {
    // "its Hit Point maximum decreases by an amount equal to the damage taken"; srd:rule:hit-points: "You can't have more
    // Hit Points than your Hit Point maximum".
    const full = adjustHpMax(hardy(), drain(-7));
    expect(full.character.hp).toEqual({ max: 23, current: 23, temp: 0 });
    expect(message(full)).toBe('HP maximum 30 → 23, HP 30 → 23 (Life Drain −7, until a Long Rest)');
    const hurt = adjustHpMax(hardy(10), drain(-7));
    expect(hurt.character.hp).toEqual({ max: 23, current: 10, temp: 0 });
    expect(message(hurt)).toBe('HP maximum 30 → 23 (Life Drain −7, until a Long Rest)');
    const twice = adjustHpMax(hurt.character, drain(-5));
    expect(twice.character.hpMaxAdjustments).toEqual([{ name: 'Life Drain', amount: -12, ends: 'long-rest' }]);
    expect(message(twice)).toBe('HP maximum 23 → 18 (Life Drain −5, −12 in all, until a Long Rest)');
    // Another name keeps its own entry.
    expect(adjustHpMax(twice.character, { name: 'Mummy Rot', change: -2, ends: 'when-ended' }).character.hpMaxAdjustments).toHaveLength(2);
  });

  it('one name is one entry, so hp_max_end and the status line know each by its name alone', () => {
    const drained = adjustHpMax(hardy(), drain(-12)).character; // 18/18
    // Another end under that name is refused, so ending it by name can't end both.
    const curse = adjustHpMax(drained, { name: 'Life Drain', change: -5, ends: 'when-ended' });
    expect(curse.character).toBe(drained);
    expect(curse.events).toEqual([
      { type: 'warning', message: 'Life Drain −12 (until a Long Rest) goes by that name: give this change another name, or end that one first.' },
    ]);
    // So is a lasting change under an effect's name, and an effect under a lasting change's.
    expect(adjustHpMax(drained, { name: 'life drain', change: 3, ends: 'never' }).character).toBe(drained);
    const boon = adjustHpMax(hardy(), { name: 'Boon', change: 4, ends: 'never' }).character;
    expect(adjustHpMax(boon, { name: 'Boon', change: -2, ends: 'long-rest' }).events[0].message).toBe(
      'Boon +4 (lasting) goes by that name: give this change another name, or end that one first.',
    );
    // A name with its own qualifier is its own entry: named exactly, only it ends; by the base name, every one does.
    let bites = adjustHpMax(hardy(), { name: 'Bite (Vampire Spawn)', change: -4, ends: 'long-rest' }).character;
    bites = adjustHpMax(bites, { name: 'Bite (Otyugh)', change: -5, ends: 'when-ended' }).character; // 21/21
    const otyugh = endHpMaxAdjustments(bites, 'Bite (Otyugh)').character;
    expect(hpMaxAdjustments(otyugh)).toEqual([{ name: 'Bite (Vampire Spawn)', amount: -4, ends: 'long-rest' }]);
    expect(endHpMaxAdjustments(bites, 'Bite').character.hp.max).toBe(30);
    // Another qualifier's entry isn't the one named: the Otyugh's gone, the Vampire Spawn's stays until the Long Rest.
    const again = endHpMaxAdjustments(otyugh, 'Bite (Otyugh)');
    expect(again.character).toBe(otyugh);
    expect(again.events).toEqual([
      { type: 'warning', message: 'No Hit Point maximum adjustment named "Bite (Otyugh)" (in effect: Bite (Vampire Spawn) −4 (until a Long Rest)).' },
    ]);
    // A stronger casting of the same spell replaces its entry whatever its end (srd:rule:casting-spells-effects-combining-spell-effects).
    const aided = adjustHpMax(hardy(), aid).character;
    const feast = adjustHpMax(aided, { name: 'Aid', change: 10, ends: 'when-ended' });
    expect(feast.character.hpMaxAdjustments).toEqual([{ name: 'Aid', amount: 10, ends: 'when-ended' }]);
    // A draining hit under a name its drain can't take, or a blank one, is refused whole: no damage lands without its
    // drain (srd:monster:wraith: "its Hit Point maximum decreases by an amount equal to the damage taken").
    const cursed = adjustHpMax(hardy(), { name: 'Life Drain', change: -5, ends: 'when-ended' }).character; // 25/25
    const hit = applyDrainingDamage(cursed, 10, { damageType: 'necrotic', drain: 'Life Drain' });
    expect(hit.character).toBe(cursed);
    expect(hit.events).toEqual([
      {
        type: 'warning',
        message:
          "Life Drain −5 (until ended) goes by that name: give this change another name, or end that one first. This hit wasn't applied (neither its damage nor its drain).",
      },
    ]);
    const full = hardy();
    const blank = applyDrainingDamage(full, 10, { damageType: 'necrotic', drain: ' \n\t ' });
    expect(blank.character).toBe(full);
    expect(blank.events).toEqual([
      { type: 'warning', message: 'A drain needs a name (the effect, as in "Life Drain"). This hit wasn\'t applied (neither its damage nor its drain).' },
    ]);
    expect(drainProblem(cursed, 'Life Drain (Wraith)')).toBeNull();
    // A lasting change under a lasting entry's name adds up either way; an effect's can't go the other way.
    const lowered = adjustHpMax(boon, { name: 'Boon', change: -2, ends: 'never' });
    expect(lowered.character.hpMaxAdjustments).toEqual([{ name: 'Boon', amount: 2, ends: 'never' }]);
    expect(message(lowered)).toBe('HP maximum 34 → 32, HP 34 → 32 (Boon −2, +2 in all, lasting)');
  });

  it('a maximum of 0 kills (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death)', () => {
    // "A creature dies if its Hit Point maximum reaches 0."
    const focused = mira({ hp: { max: 17, current: 12, temp: 4 }, spellcasting: { ...mira().spellcasting!, concentratingOn: 'Shield' } });
    const r = adjustHpMax(focused, drain(-20));
    expect(r.character.hp).toEqual({ max: 0, current: 0, temp: 0 });
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.character.spellcasting?.concentratingOn).toBeNull();
    expect(r.character.hpMaxAdjustments).toEqual([{ name: 'Life Drain', amount: -17, ends: 'long-rest' }]);
    expect(r.events[0]).toEqual({ type: 'died', message: 'HP maximum 17 → 0 (Life Drain −17, until a Long Rest): a creature dies if its Hit Point maximum reaches 0.' });
    // A dying hero drained to 0 dies too.
    expect(adjustHpMax(dying(), drain(-17)).character.deathSaves.dead).toBe(true);
  });

  it("Harm can't reduce a maximum below 1 (srd:spell:harm)", () => {
    // "This spell can't reduce a target's Hit Point maximum below 1."
    const r = adjustHpMax(hardy(), { name: 'Harm', change: -40, ends: 'long-rest' });
    expect(r.character.hp).toEqual({ max: 1, current: 1, temp: 0 });
    expect(r.character.deathSaves.dead).toBe(false);
    expect(message(r)).toBe("HP maximum 30 → 1, HP 30 → 1 (Harm −29: it can't reduce a Hit Point maximum below 1, until a Long Rest)");
    const again = adjustHpMax(r.character, { name: 'Harm', change: -5, ends: 'long-rest' });
    expect(again.character).toBe(r.character);
    expect(again.events[0].type).toBe('warning');
  });

  it('a lasting change moves current HP with the maximum, like Constitution (srd:rule:level-advancement-gaining-a-level)', () => {
    // The Constitution precedent: a lasting change to the maximum moves current HP with it; a hero at 0 stays at 0.
    const tough = { name: 'Tough (missed at 1st level)', change: 4, ends: 'never' } as const;
    const r = adjustHpMax(mira(), tough);
    expect(r.character.hp).toEqual({ max: 21, current: 16, temp: 0 });
    expect(message(r)).toBe('HP maximum 17 → 21, HP 12 → 16 (Tough (missed at 1st level) +4, lasting)');
    const down = adjustHpMax(dying(), tough);
    expect(down.character.hp).toEqual({ max: 21, current: 0, temp: 0 });
    expect(ids(down.character)).toContain('unconscious');
    expect(message(down)).toBe('HP maximum 17 → 21 (Tough (missed at 1st level) +4, lasting); HP stays 0 until healed');
    // The same name lowered by the same amount takes it back.
    const back = adjustHpMax(r.character, { ...tough, change: -4 });
    expect(back.character.hp).toEqual({ max: 17, current: 12, temp: 0 });
    expect(back.character).not.toHaveProperty('hpMaxAdjustments');
    expect(message(back)).toBe('HP maximum 21 → 17, HP 16 → 12 (Tough (missed at 1st level) −4, taken back, lasting)');
    // Never below 1, never a death.
    const plain = mira();
    const floor = adjustHpMax(plain, { name: 'Curse ruling', change: -17, ends: 'never' });
    expect(floor.character).toBe(plain);
    expect(floor.events[0]).toMatchObject({ type: 'warning', message: "A lasting change can't take the Hit Point maximum below 1 (it is 17)." });
    expect(adjustHpMax(mira(), { name: 'Curse ruling', change: -16, ends: 'never' }).character.hp).toEqual({ max: 1, current: 1, temp: 0 });
  });

  it("refuses an effect of the opposite sign under an effect's name", () => {
    const aided = adjustHpMax(mira(), aid).character;
    const r = adjustHpMax(aided, { name: 'aid', change: -3, ends: 'long-rest' });
    expect(r.character).toBe(aided);
    expect(r.events[0].message).toBe('Aid raises the Hit Point maximum: end it first, or give this change another name.');
  });

  it('ending gives back exactly what each changed (srd:spell:greater-restoration)', () => {
    // Greater Restoration ends "Any reduction to the target's Hit Point maximum"; Aid ending lowers current HP only to fit.
    const aided = adjustHpMax(mira(), aid).character; // 17/22
    const healed = applyHealing(aided, 3).character; // 20/22
    const ended = endHpMaxAdjustments(healed, 'Aid');
    expect(ended.character.hp).toEqual({ max: 17, current: 17, temp: 0 });
    expect(ended.character).not.toHaveProperty('hpMaxAdjustments');
    expect(message(ended)).toBe('Aid +5 ends: HP maximum 22 → 17, HP 20 → 17');
    const hurt = applyDamage(aided, 2).character; // 15/22
    expect(endHpMaxAdjustments(hurt, 'Aid').character.hp).toEqual({ max: 17, current: 15, temp: 0 });
    // A reduction ending raises only the maximum: "returns to normal" doesn't heal.
    const drained = adjustHpMax(hardy(10), drain(-7)).character; // 10/23
    const restored = endHpMaxAdjustments(drained, 'Life Drain');
    expect(restored.character.hp).toEqual({ max: 30, current: 10, temp: 0 });
    expect(message(restored)).toBe('Life Drain −7 ends: HP maximum 23 → 30');
    // The spell's name ends a casting named with its level, and the other way round.
    const upcast = adjustHpMax(mira(), { name: 'Aid (3rd level)', change: 10, ends: 'long-rest' }).character;
    expect(endHpMaxAdjustments(upcast, 'aid').character.hp.max).toBe(17);
    expect(endHpMaxAdjustments(aided, 'Aid (2nd level)').character.hp.max).toBe(17);
  });

  it("ends only the entry of a name with the given end (the sheet's ×), and every one of the name without it", () => {
    // Two entries of one name come only from a hand-edited file: the engine refuses a second end under a name.
    const both = hardy(22, {
      hp: { max: 22, current: 22, temp: 0 },
      hpMaxAdjustments: [
        { name: 'Life Drain', amount: -5, ends: 'long-rest' },
        { name: 'Life Drain', amount: -3, ends: 'when-ended' },
      ],
    });
    const curse = endHpMaxAdjustments(both, 'Life Drain', 'when-ended');
    expect(curse.character.hpMaxAdjustments).toEqual([{ name: 'Life Drain', amount: -5, ends: 'long-rest' }]);
    expect(curse.character.hp.max).toBe(25);
    expect(endHpMaxAdjustments(both, 'Life Drain').character.hp.max).toBe(30);
    expect(endHpMaxAdjustments(both, 'Life Drain', 'never').character).toBe(both);
  });

  it('ending an unknown name warns with what is in effect', () => {
    const aided = adjustHpMax(adjustHpMax(hardy(), aid).character, drain(-10)).character;
    const r = endHpMaxAdjustments(aided, 'Aidd');
    expect(r.character).toBe(aided);
    expect(r.events[0]).toEqual({
      type: 'warning',
      message: 'No Hit Point maximum adjustment named "Aidd" (in effect: Aid +5 (until a Long Rest), Life Drain −10 (until a Long Rest)).',
    });
    expect(endHpMaxAdjustments(mira(), 'Aid').events[0].message).toBe('No Hit Point maximum adjustment named "Aid".');
  });

  it('ending on the dead gives the maximum back; the hero stays dead', () => {
    const dead = adjustHpMax(mira(), drain(-20)).character;
    const r = endHpMaxAdjustments(dead, 'Life Drain');
    expect(r.character.hp).toEqual({ max: 17, current: 0, temp: 0 });
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.character).not.toHaveProperty('hpMaxAdjustments');
  });

  it('Aid ending under a bigger curse kills, and the curse ending later gives back the hero\'s own maximum (srd:monster:mummy)', () => {
    // A Mummy's curse: "its Hit Point maximum doesn't return to normal when finishing a Long Rest" (until ended).
    const aided = adjustHpMax(mira(), aid).character; // 17/22
    const cursed = adjustHpMax(aided, { name: 'Mummy Rot', change: -20, ends: 'when-ended' }).character; // 2/2
    expect(cursed.hp).toEqual({ max: 2, current: 2, temp: 0 });
    const r = endHpMaxAdjustments(cursed, 'Aid');
    expect(r.character.hp).toEqual({ max: 0, current: 0, temp: 0 });
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.character.hpMaxAdjustments).toEqual([{ name: 'Mummy Rot', amount: -17, ends: 'when-ended' }]);
    expect(r.events[0]).toEqual({ type: 'died', message: 'Aid +5 ends: HP maximum 2 → 0 — a creature dies if its Hit Point maximum reaches 0.' });
    expect(endHpMaxAdjustments(r.character, 'Mummy Rot').character.hp).toEqual({ max: 17, current: 0, temp: 0 });
  });

  it('ends reductions before raises in one call, whatever the order of the names, so ending both never dips the maximum', () => {
    const aided = adjustHpMax(mira(), aid).character; // 17/22
    const drained = adjustHpMax(aided, drain(-20)).character; // 2/2: Greater Restoration, then Aid runs out
    for (const names of [['Aid', 'Life Drain'], ['Life Drain', 'Aid']]) {
      const r = endHpMaxAdjustments(drained, names);
      expect(r.character.deathSaves.dead, names.join()).toBe(false);
      expect(r.character.hp).toEqual({ max: 17, current: 2, temp: 0 });
      expect(r.events.map((e) => e.message)).toEqual(['Life Drain −20 ends: HP maximum 2 → 22', 'Aid +5 ends: HP maximum 22 → 17']);
    }
    expect(endHpMaxAdjustmentsWhere(drained, (a) => a.ends === 'long-rest').character.hp).toEqual({ max: 17, current: 2, temp: 0 });
    // Aid that ran out first is ended alone, first: then it kills (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death).
    expect(endHpMaxAdjustments(drained, 'Aid').character.deathSaves.dead).toBe(true);
    // A name that finds nothing warns with what is left in effect after the others end.
    const some = endHpMaxAdjustments(drained, ['Life Drain', 'Bless']);
    expect(some.character.hp.max).toBe(22);
    expect(some.events.map((e) => e.type)).toEqual(['hp-changed', 'warning']);
    expect(some.events[1].message).toBe('No Hit Point maximum adjustment named "Bless" (in effect: Aid +5 (until a Long Rest)).');
    expect(endHpMaxAdjustments(drained, ['Aid', 'Life Drain', 'Bless']).events[2].message).toBe('No Hit Point maximum adjustment named "Bless".');
  });

  it('takes back a lasting reduction before Aid ends in one call, so ending both never kills (srd:rule:...-instant-death)', () => {
    // "A creature dies if its Hit Point maximum reaches 0": together the maximum goes 4 → 5 and never reaches 0.
    const aided = adjustHpMax(mira({ hp: { max: 30, current: 30, temp: 0 } }), aid).character; // 35/35
    const cursed = adjustHpMax(aided, { name: 'Mummy Rot', change: -25, ends: 'when-ended' }).character; // 10/10
    const ruled = adjustHpMax(cursed, { name: 'Lost an eye (ruling)', change: -6, ends: 'never' }).character; // 4/4
    for (const names of [['Lost an eye (ruling)', 'Aid'], ['Aid', 'Lost an eye (ruling)']]) {
      const r = endHpMaxAdjustments(ruled, names);
      expect(r.character.deathSaves.dead, names.join()).toBe(false);
      expect(r.character.hp).toEqual({ max: 5, current: 5, temp: 0 });
      expect(r.character.hpMaxAdjustments).toEqual([{ name: 'Mummy Rot', amount: -25, ends: 'when-ended' }]);
      expect(r.events.map((e) => e.message)).toEqual([
        'Lost an eye (ruling) −6 taken back: HP maximum 4 → 10, HP 4 → 10',
        'Aid +5 ends: HP maximum 10 → 5, HP 10 → 5',
      ]);
    }
    // A lasting raise is still taken back last, after the effects' raises.
    const boon = adjustHpMax(aided, { name: 'Boon', change: 3, ends: 'never' }).character; // 38/38
    expect(endHpMaxAdjustments(boon, ['Boon', 'Aid']).events.map((e) => e.message)).toEqual([
      'Aid +5 ends: HP maximum 38 → 33, HP 38 → 33',
      'Boon +3 taken back: HP maximum 33 → 30, HP 33 → 30',
    ]);
  });

  it("takes a shortfall off an effect's reduction before a lasting one, which outlasts it (srd:monster:mummy)", () => {
    // A ruling is part of the hero's own maximum; the curse that ran the maximum into 0 gives up the shortfall.
    const aided = adjustHpMax(mira(), aid).character; // 17/22
    const cursed = adjustHpMax(aided, { name: 'Mummy Rot', change: -18, ends: 'when-ended' }).character; // 4/4
    const ruled = adjustHpMax(cursed, { name: 'Lost an eye (ruling)', change: -3, ends: 'never' }).character; // 1/1
    const r = endHpMaxAdjustments(ruled, 'Aid');
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.character.hpMaxAdjustments).toEqual([
      { name: 'Mummy Rot', amount: -14, ends: 'when-ended' },
      { name: 'Lost an eye (ruling)', amount: -3, ends: 'never' },
    ]);
    // Ending the curse gives back the hero's own maximum, the ruling's −3 included: 17 − 3.
    expect(endHpMaxAdjustments(r.character, 'Mummy Rot').character.hp.max).toBe(14);
    // A lasting cut made while Aid held the maximum up gives up what no effect can.
    const cut = adjustHpMax(aided, { name: 'Ruling', change: -21, ends: 'never' }).character; // 1/1 (own 17 − 21)
    const alone = endHpMaxAdjustments(cut, 'Aid');
    expect(alone.character.hp.max).toBe(0);
    expect(alone.character.hpMaxAdjustments).toEqual([{ name: 'Ruling', amount: -17, ends: 'never' }]);
  });

  it('a lasting entry is taken back as bookkeeping, and never below a maximum of 1', () => {
    const boon = adjustHpMax(mira(), { name: 'Blessing of the Grove', change: 6, ends: 'never' }).character; // 18/23
    expect(message(endHpMaxAdjustments(boon, 'Blessing of the Grove'))).toBe('Blessing of the Grove +6 taken back: HP maximum 23 → 17, HP 18 → 12');
    const drained = adjustHpMax(boon, drain(-20)).character; // 3/3
    const kept = endHpMaxAdjustments(drained, 'Blessing of the Grove');
    // Nothing ended: the same character back, with the warning alone.
    expect(kept.character).toBe(drained);
    expect(kept.events[0]).toEqual({ type: 'warning', message: 'Blessing of the Grove +6 stays: taking it back would leave a Hit Point maximum below 1.' });
  });

  it('damageTaken applies the Defenses in order (srd:rule:damage-and-healing-resistance-and-vulnerability)', () => {
    // "Resistance is applied second; and Vulnerability is applied third."
    expect(damageTaken(hardy(30, { damageResistances: ['Necrotic'] }), 21, 'necrotic')).toBe(10);
    expect(damageTaken(hardy(30, { damageImmunities: ['necrotic'] }), 21, 'necrotic')).toBe(0);
    expect(damageTaken(hardy(30, { damageVulnerabilities: ['necrotic'] }), 21, 'necrotic')).toBe(42);
    expect(damageTaken(hardy(30, { damageResistances: ['necrotic'], damageVulnerabilities: ['necrotic'] }), 21, 'necrotic')).toBe(20);
    expect(damageTaken(hardy(), 21)).toBe(21);
    expect(damageTaken(adjustHpMax(mira(), drain(-20)).character, 21)).toBe(0);
  });

  it('a draining hit lowers the maximum by the damage taken, temporary HP included (srd:rule:damage-and-healing-temporary-hit-points)', () => {
    // "If you have Temporary Hit Points and take damage, those points are lost first": the damage is still taken.
    const r = applyDrainingDamage(hardy(30, { hp: { max: 30, current: 30, temp: 8 } }), 21, { damageType: 'necrotic', drain: 'Life Drain' });
    expect(r.character.hp).toEqual({ max: 9, current: 9, temp: 0 });
    expect(r.events.map((e) => e.message)).toEqual([
      'HP 30 → 17 (21 necrotic; 8 absorbed by temporary HP)',
      'HP maximum 30 → 9, HP 17 → 9 (Life Drain −21, until a Long Rest)',
    ]);
    const resisted = applyDrainingDamage(hardy(30, { damageResistances: ['necrotic'] }), 21, { damageType: 'necrotic', drain: 'Life Drain' });
    expect(resisted.character.hp).toEqual({ max: 20, current: 20, temp: 0 });
  });

  it('judges massive damage on the maximum before the drain (srd:rule:...-instant-death, Massive Damage)', () => {
    // "the character dies if the remainder equals or exceeds their Hit Point maximum": 15 left over is less than 30.
    const r = applyDrainingDamage(hardy(10), 25, { damageType: 'necrotic', drain: 'Life Drain' });
    expect(r.character.hp).toEqual({ max: 5, current: 0, temp: 0 });
    expect(r.character.deathSaves.dead).toBe(false);
    expect(ids(r.character)).toContain('unconscious');
    // Immunity drains nothing; a hit that kills drains nothing.
    const immune = hardy(30, { damageImmunities: ['necrotic'] });
    expect(applyDrainingDamage(immune, 21, { damageType: 'necrotic', drain: 'Life Drain' }).character).toBe(immune);
    const killed = applyDrainingDamage(hardy(5, { hp: { max: 10, current: 5, temp: 0 } }), 20, { drain: 'Life Drain' });
    expect(killed.character.deathSaves.dead).toBe(true);
    expect(killed.character).not.toHaveProperty('hpMaxAdjustments');
    expect(killed.events.map((e) => e.type)).toEqual(['died']);
  });

  it('composes with level-ups: ending Aid keeps the new level\'s Hit Points (srd:rule:level-advancement-gaining-a-level)', () => {
    // "add the total (minimum of 1) to your Hit Point maximum": a level adds to the maximum in force.
    const aided = adjustHpMax(mira(), aid).character; // 17/22
    const four = levelUp(aided, { className: 'Wizard', hpMethod: 'average' });
    expect(four.character.hp.max).toBe(22 + four.hpGained);
    expect(endHpMaxAdjustments(four.character, 'Aid').character.hp.max).toBe(17 + four.hpGained);
  });

  it('changeInitiativeBonus adds to the bonus beyond Dexterity; Alert keeps growing at level-ups (srd:feat:alert)', () => {
    // "When you roll Initiative, you can add your Proficiency Bonus to the roll"; a level-up adds the bonus's growth.
    const alert = mira({ classes: [{ ...mira().classes[0], level: 4 }], features: [{ id: 'al', name: 'Alert', source: 'feat', description: '' }] });
    const r = changeInitiativeBonus(alert, 2);
    expect(r.character.initiativeBonusExtra).toBe(2);
    expect(r.events).toEqual([{ type: 'combat', message: 'Initiative +2 → +4' }]);
    expect(changeInitiativeBonus(alert, 0).character).toBe(alert);
    expect(levelUp(r.character, { className: 'Wizard', hpMethod: 'average' }).character.initiativeBonusExtra).toBe(3);
    expect(changeInitiativeBonus(r.character, -5).events[0].message).toBe('Initiative +4 → −1');
  });

  it('reads stored entries leniently', () => {
    const odd = mira({
      hpMaxAdjustments: [
        { name: 'Aid', amount: 5, ends: 'long-rest' },
        { name: '', amount: 3, ends: 'never' },
        { name: 'Zero', amount: 0, ends: 'never' },
        { name: 'Future', amount: -2, ends: 'next-dawn' as never },
      ],
    });
    expect(hpMaxAdjustments(odd)).toEqual([
      { name: 'Aid', amount: 5, ends: 'long-rest' },
      { name: 'Future', amount: -2, ends: 'when-ended' },
    ]);
    expect(hpMaxAdjustments(mira())).toEqual([]);
  });

  it('reads a name as the engine writes it (one line, at most 60 characters), so one from a hand-edited file can be ended', () => {
    const long = 'Curse of the Drowned Lantern,\n  laid by the Hag of Saltmarsh Docks at the old mill';
    const cursed = hardy(25, { hp: { max: 25, current: 25, temp: 0 }, hpMaxAdjustments: [{ name: long, amount: -5, ends: 'when-ended' }] });
    expect(hpMaxAdjustments(cursed)).toEqual([{ name: 'Curse of the Drowned Lantern, laid by the Hag of Saltmarsh D', amount: -5, ends: 'when-ended' }]);
    // The sheet's × passes the name it shows; the stored name ends too.
    for (const name of [hpMaxAdjustments(cursed)[0].name, long]) {
      const r = endHpMaxAdjustments(cursed, name, 'when-ended');
      expect(r.character.hp.max, name).toBe(30);
      expect(r.character).not.toHaveProperty('hpMaxAdjustments');
    }
  });

  it('a Constitution change composes with the effects in force: their records still add up (srd:rule:level-advancement-gaining-a-level)', () => {
    // Gaining a Level: "When your Constitution modifier increases by 1, your Hit Point maximum increases by 1 for each level
    // you have attained." Mira is a 3rd-level Wizard with Constitution 13 (+1): 13 → 9 is −2 per level, −6.
    const drained = adjustHpMax(mira({ hp: { max: 17, current: 17, temp: 0 } }), drain(-10)).character; // 7/7
    const weaker = changeAbilityScore(drained, 'con', -4);
    expect(weaker.character.hp).toEqual({ max: 1, current: 1, temp: 0 });
    expect(weaker.character.hpMaxAdjustments).toEqual(drained.hpMaxAdjustments);
    // Long Rest: "If your Hit Point maximum was reduced, it returns to normal": the new normal, 11.
    expect(endHpMaxAdjustments(weaker.character, 'Life Drain').character.hp.max).toBe(11);
    // Without effects the hero's own maximum never goes below 1, as before.
    expect(changeAbilityScore(mira({ hp: { max: 5, current: 5, temp: 0 } }), 'con', -4).character.hp.max).toBe(1);
    // A lasting entry is part of the hero's own maximum: the floor of 1 holds it, and its record stays.
    const ruled = adjustHpMax(mira({ hp: { max: 8, current: 8, temp: 0 } }), { name: 'Ruling', change: -3, ends: 'never' }).character; // 5/5
    const ruledWeaker = changeAbilityScore(ruled, 'con', -4).character;
    expect(ruledWeaker.hp).toEqual({ max: 1, current: 1, temp: 0 });
    expect(ruledWeaker.deathSaves.dead).toBe(false);
    expect(ruledWeaker.hpMaxAdjustments).toEqual([{ name: 'Ruling', amount: -3, ends: 'never' }]);
    // An increase adds exactly its Hit Points, 13 → 15 being +1 per level: +3, even where a lasting cut made under Aid
    // took the hero's own maximum below 1.
    const aided = adjustHpMax(mira({ hp: { max: 17, current: 17, temp: 0 } }), aid).character; // 22/22
    const cut = adjustHpMax(aided, { name: 'Ruling', change: -21, ends: 'never' }).character; // 1/1 (own 17 − 21)
    const stronger = changeAbilityScore(cut, 'con', 2);
    expect(stronger.character.hp).toEqual({ max: 4, current: 4, temp: 0 });
    expect(stronger.events.map((e) => e.message)).toEqual(['Constitution 13 → 15', 'HP maximum 1 → 4 (Constitution modifier +1 per level)']);
  });

  it('a Constitution loss a drain holds within reach of 0 kills, like Aid ending (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death)', () => {
    // "A creature dies if its Hit Point maximum reaches 0." Harm's floor is its own: "This spell can't reduce a target's
    // Hit Point maximum below 1".
    const harmed = adjustHpMax(mira({ hp: { max: 17, current: 17, temp: 0 } }), { name: 'Harm', change: -30, ends: 'long-rest' }).character; // 1/1
    const r = changeAbilityScore(harmed, 'con', -4);
    expect(r.character.abilityScores.con).toBe(9);
    expect(r.character.hp).toEqual({ max: 0, current: 0, temp: 0 });
    expect(r.character.deathSaves.dead).toBe(true);
    expect(r.events.map((e) => e.message)).toEqual([
      'Constitution 13 → 9',
      'HP maximum 1 → 0 (Constitution modifier -2 per level) — a creature dies if its Hit Point maximum reaches 0.',
    ]);
    // The shortfall comes off the drain, so the records add up to 0 and its end gives back the hero's own maximum, 11.
    expect(r.character.hpMaxAdjustments).toEqual([{ name: 'Harm', amount: -11, ends: 'long-rest' }]);
    expect(endHpMaxAdjustments(r.character, 'Harm').character.hp.max).toBe(11);
    // On the dead it is bookkeeping: a maximum of 0 stays 0 on a decrease (the death-save pips stay locked), and the
    // shortfall still comes off the drain.
    const dead = adjustHpMax(mira({ hp: { max: 17, current: 17, temp: 0 } }), drain(-20)).character; // dead, Life Drain −17
    const lower = changeAbilityScore(dead, 'con', -2);
    expect(lower.character.hp.max).toBe(0);
    expect(lower.events).toEqual([{ type: 'combat', message: 'Constitution 13 → 11' }]);
    expect(lower.character.hpMaxAdjustments).toEqual([{ name: 'Life Drain', amount: -14, ends: 'long-rest' }]);
    expect(changeAbilityScore(lower.character, 'con', 2).character.hp.max).toBe(3);
    // A dead hero given a maximum back (the drain ended) who loses it again: logged, and the shortfall off the curse.
    const cursed = adjustHpMax(mira({ hp: { max: 17, current: 17, temp: 0 } }), { name: 'Mummy Rot', change: -10, ends: 'when-ended' }).character; // 7/7
    const drainedDead = endHpMaxAdjustments(adjustHpMax(cursed, drain(-7)).character, 'Life Drain').character; // dead, 0/7
    expect(drainedDead.hp).toEqual({ max: 7, current: 0, temp: 0 });
    const weakest = changeAbilityScore(drainedDead, 'con', -6); // 13 → 7: −3 per level, −9
    expect(weakest.character.hp).toEqual({ max: 0, current: 0, temp: 0 });
    expect(weakest.events.map((e) => e.message)).toEqual(['Constitution 13 → 7', 'HP maximum 7 → 0 (Constitution modifier -3 per level)']);
    expect(weakest.character.hpMaxAdjustments).toEqual([{ name: 'Mummy Rot', amount: -8, ends: 'when-ended' }]);
    // A decrease never raises a maximum of 0, records or none.
    const gone = mira({ hp: { max: 0, current: 0, temp: 0 }, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } });
    expect(changeAbilityScore(gone, 'con', -2).character.hp.max).toBe(0);
  });
});
