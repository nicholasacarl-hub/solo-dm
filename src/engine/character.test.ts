import { describe, expect, it } from 'vitest';
import type { Character, Feature, ImportedRef, InventoryItem } from '@/types';
import { sampleCharacter } from '@/test/fixtures';
import {
  addAcSpell,
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
  endAcSpell,
  endHpMaxAdjustments,
  endHpMaxAdjustmentsWhere,
  hpMaxAdjustmentLabel,
  hpMaxAdjustments,
  changeCurrency,
  changeExhaustion,
  clearTempHp,
  concentrationSaveDC,
  createBlankCharacter,
  expireConcentration,
  featureLabel,
  featureToRewrite,
  findFeature,
  findItem,
  formatCurrency,
  gainXp,
  readsItsTable,
  recordDeathSave,
  removeCondition,
  removeFeature,
  removeItem,
  removeSpell,
  removeSpellById,
  restoreFeature,
  setConcentration,
  setHeroicInspiration,
  setTempHp,
  stabilize,
  totalGp,
  updateItem,
  useFeature,
} from './character';
import { applyLongRest, levelUp } from './progression';
import { countedAcSpells } from './rules';
import { characterStatusLine } from './summary';

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

describe("counted families: the one entry a level-up keeps, by any of the table's names (SRD 5.2.1 Fighter Features table)", () => {
  // srd:class:fighter, Fighter Features table: "Indomitable (one use)" at 9, "Indomitable (two uses)" at 13,
  // "Indomitable (three uses)" at 17. Indomitable: "You can use this feature twice before a Long Rest starting at level
  // 13 and three times before a Long Rest starting at level 17."
  const indomitable = (id: string, name: string, max: number, used = 0, extra: Partial<Feature> = {}): Feature => ({
    id,
    name,
    source: 'class',
    sourceName: 'Fighter 9',
    description: 'Reroll a failed saving throw.',
    uses: { max, used, recharge: 'long' },
    ...extra,
  });
  const fighter = (features: Feature[]) =>
    mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 13, hitDie: 10, casterType: 'none' }], spellcasting: undefined, features });
  const tableRow = (name: string, max?: number): Omit<Feature, 'id'> => ({
    name,
    source: 'class',
    sourceName: 'Granted in play',
    description: 'Reroll a failed saving throw.',
    ...(max ? { uses: { max, used: 0, recharge: 'long' as const } } : {}),
  });
  /** A book's Fighter of the given edition: a 2024 book's stands in for the SRD Fighter (rulesClassFor), whose table counts Indomitable. */
  const bookFighter = (level: number, format: ImportedRef['format'] = '2024') => ({
    classId: 'lib:lantern:class:fighter',
    name: 'Fighter',
    level,
    hitDie: 10 as const,
    casterType: 'none' as const,
    ref: { sourceId: 'lantern', sourceTitle: 'The Lanternfall Handbook', entryId: 'lib:lantern:class:fighter', kind: 'class' as const, entryName: 'Fighter', format, textHash: '', textCopied: false },
  });

  it('finds the entry by the name the sheet had when the session began: "Indomitable (one use)" uses "Indomitable (two uses)"', () => {
    const c = fighter([indomitable('ind', 'Indomitable (two uses)', 2)]);
    const used = useFeature(c, 'Indomitable (one use)');
    expect(used.character.features[0].uses?.used).toBe(1);
    expect(used.events[0].message).toBe('Used Indomitable (two uses) (1/2 left; recharges on a Long Rest)');
    expect(restoreFeature(used.character, 'Indomitable (three uses)').events[0].message).toBe('Indomitable (two uses): regained 1 use (2/2)');
    // The bare name found it before and still does.
    expect(useFeature(c, 'Indomitable').events[0].message).toBe('Used Indomitable (two uses) (1/2 left; recharges on a Long Rest)');
    // An older sheet's two entries: the one with a use left, as for any two of one name.
    const old = fighter([indomitable('ind1', 'Indomitable (one use)', 1, 1), indomitable('ind2', 'Indomitable (two uses)', 2, 0, { sourceName: 'Fighter 13' })]);
    expect(useFeature(old, 'Indomitable (three uses)').character.features.map((f) => f.uses?.used)).toEqual([1, 1]);
  });

  it('counted families only: a count on a name whose family no entry counts, or another parenthetical, finds nothing new', () => {
    const wind: Feature = { id: 'wind', name: 'Second Wind', source: 'class', sourceName: 'Fighter 1', description: '', uses: { max: 4, used: 0, recharge: 'long' } };
    expect(useFeature(fighter([wind]), 'Second Wind (two uses)').events[0].message).toBe('No feature named "Second Wind (two uses)".');
    // srd:class:warlock: Mystic Arcanum "(level 6 spell)" and "(level 7 spell)" are two spells, not counts.
    const arcanum: Feature = { id: 'ma6', name: 'Mystic Arcanum (level 6 spell)', source: 'class', sourceName: 'Warlock 11', description: '', uses: { max: 1, used: 0, recharge: 'long' } };
    expect(useFeature(fighter([arcanum]), 'Mystic Arcanum (level 7 spell)').events[0].message).toBe('No feature named "Mystic Arcanum (level 7 spell)".');
    // Nor does another parenthetical on a counted family's base: a DM's homebrew "Indomitable (Tactical)" isn't Indomitable.
    expect(useFeature(fighter([indomitable('ind', 'Indomitable (two uses)', 2)]), 'Indomitable (Tactical)').events[0].message).toBe('No feature named "Indomitable (Tactical)".');
  });

  it("features_add of the table's name rewrites the family's entry, not a second one; the table's count is no ruling, and clears one", () => {
    const c = fighter([indomitable('ind', 'Indomitable (one use)', 1, 1)]);
    const r = addFeature(c, tableRow('Indomitable (two uses)', 2));
    expect(r.character.features).toEqual([{ ...c.features[0], name: 'Indomitable (two uses)', uses: { max: 2, used: 1, recharge: 'long' } }]);
    expect(r.events[0].message).toBe('Updated feature: Indomitable (one use) → Indomitable (two uses)');
    // Another number than the name's is the DM's ruling, as for any rewrite.
    expect(addFeature(c, { ...tableRow('Indomitable (two uses)'), uses: { max: 3, used: 0, recharge: 'long' } }).character.features[0].uses).toEqual({ max: 3, used: 1, recharge: 'long', ruled: true });
    // A ruling made under the old name (today's features_add "Indomitable (one use)" uses_max 2) is cleared by the
    // table's count, under the table's name or the old one.
    const ruled = fighter([indomitable('ind', 'Indomitable (one use)', 2, 0, { uses: { max: 2, used: 0, recharge: 'long', ruled: true } })]);
    expect(addFeature(ruled, tableRow('Indomitable (two uses)', 2)).character.features[0].uses).toEqual({ max: 2, used: 0, recharge: 'long' });
    expect(addFeature(ruled, tableRow('Indomitable (one use)', 1)).character.features[0].uses).toEqual({ max: 1, used: 0, recharge: 'long' });
    // Without uses the rewrite changes only the entry's text: it keeps its name and its uses, so its name never counts
    // what its uses don't (the DM's features_add gives an entry counting fewer the name's count).
    const textOnly = addFeature(c, tableRow('Indomitable (two uses)'));
    expect(textOnly.character.features[0]).toMatchObject({ name: 'Indomitable (one use)', uses: c.features[0].uses });
    expect(textOnly.events[0].message).toBe('Updated feature: Indomitable (one use)');
    // The entry's own name in another spelling is no counted name routed onto it: the call's spelling, as always.
    expect(addFeature(c, tableRow('indomitable (one use)')).character.features[0]).toMatchObject({ name: 'indomitable (one use)', uses: c.features[0].uses });
  });

  it("features_add of the table's name rewrites the DM's own entry of the family, the DM's ruling first", () => {
    // A DM-only Fighter: the DM's features_add "Indomitable (one use)" at 9, then the Fighter 13 reminder's name.
    const dm = fighter([{ ...indomitable('dm', 'Indomitable (one use)', 1), sourceName: 'Granted in play' }]);
    const r = addFeature(dm, tableRow('Indomitable (two uses)', 2));
    expect(r.character.features.map((f) => [f.id, f.name, f.sourceName, f.uses])).toEqual([['dm', 'Indomitable (two uses)', 'Granted in play', { max: 2, used: 0, recharge: 'long' }]]);
    // The class's entry beside a ruled one of the DM's: the ruling is the entry a level-up keeps, so it is rewritten.
    const both = fighter([indomitable('ind', 'Indomitable (one use)', 1), { ...indomitable('dm', 'Indomitable', 3), sourceName: 'Granted in play', uses: { max: 3, used: 0, recharge: 'long', ruled: true } }]);
    expect(addFeature(both, tableRow('Indomitable (two uses)', 2)).character.features.map((f) => [f.id, f.name, f.uses?.max, f.uses?.ruled])).toEqual([
      ['ind', 'Indomitable (one use)', 1, undefined],
      ['dm', 'Indomitable (two uses)', 2, undefined],
    ]);
    // An older sheet's class entry beside the DM's of a table name, neither ruled: the class's is rewritten, the one a
    // level-up keeps (srd:class:fighter table: "| 17 | +6 | Action Surge (two uses), Indomitable (three uses) |").
    const older = fighter([indomitable('ind', 'Indomitable (one use)', 1), { ...indomitable('dm', 'Indomitable (two uses)', 2), sourceName: 'Granted in play' }]);
    const three = addFeature(older, tableRow('Indomitable (three uses)', 3));
    expect(three.events[0].message).toBe('Updated feature: Indomitable (one use) → Indomitable (three uses)');
    expect(three.character.features.map((f) => [f.id, f.name, f.uses?.max])).toEqual([
      ['ind', 'Indomitable (three uses)', 3],
      ['dm', 'Indomitable (two uses)', 2],
    ]);
  });

  it('a counted name beside a class feature no entry names with a count is added beside it as before (srd:class:barbarian Rage, srd:class:druid Wild Shape)', () => {
    // srd:class:barbarian, Rage: "the number of times shown for your Barbarian level in the Rages column"; srd:class:druid,
    // Wild Shape: "You can use Wild Shape twice." The class's own entries name no count: the DM's counted label is its own.
    const rage: Feature = { id: 'rage', name: 'Rage', source: 'class', sourceName: 'Barbarian 1', description: '', uses: { max: 3, used: 0, recharge: 'long' } };
    const barbarian = mira({ classes: [{ classId: 'srd:class:barbarian', name: 'Barbarian', level: 3, hitDie: 12, casterType: 'none' }], spellcasting: undefined, features: [rage] });
    const r = addFeature(barbarian, { ...tableRow('Rage (3 uses)', 3), description: 'DM words.' });
    expect(r.character.features.map((f) => [f.name, f.sourceName, f.uses?.max])).toEqual([
      ['Rage', 'Barbarian 1', 3],
      ['Rage (3 uses)', 'Granted in play', 3],
    ]);
    expect(r.events[0].message).toBe('Gained feature: Rage (3 uses) (3 uses, recharges on a Long Rest)');
    const shape: Feature = { id: 'ws', name: 'Wild Shape', source: 'class', sourceName: 'Druid 2', description: '', uses: { max: 2, used: 0, recharge: 'long' } };
    const druid = mira({ classes: [{ classId: 'srd:class:druid', name: 'Druid', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }], features: [shape] });
    expect(addFeature(druid, tableRow('Wild Shape (2 uses)', 2)).character.features.map((f) => f.name)).toEqual(['Wild Shape', 'Wild Shape (2 uses)']);
  });

  it("a counted name routed onto an entry that follows its class table's counts keeps the entry's name and scale: the table's count changes only the text, another is the DM's ruling on it", () => {
    // A 2024 book's Fighter as the offline parser names it ("Indomitable", its uses read from the table's counted cells:
    // 2 at Fighter 13), beside the DM's "Indomitable (one use)" from a features_add at 9.
    const scale = { by: 'table' as const, className: 'Fighter', values: [...Array<number>(8).fill(0), 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3] };
    const own = indomitable('ind', 'Indomitable', 2, 1, { uses: { max: 2, used: 1, recharge: 'long', scale } });
    const dm = indomitable('dm', 'Indomitable (one use)', 1, 0, { sourceName: 'Granted in play' });
    const c = mira({ classes: [bookFighter(13)], spellcasting: undefined, features: [own, dm] });
    const same = addFeature(c, { ...tableRow('Indomitable (two uses)', 2), description: 'Rewritten.', uses: { max: 2, used: 0, recharge: 'short' } });
    expect(same.character.features).toEqual([{ ...own, description: 'Rewritten.' }, dm]);
    expect(same.events[0].message).toBe('Updated feature: Indomitable');
    const three = addFeature(c, { ...tableRow('Indomitable (three uses)', 3), description: 'Rewritten.' });
    expect(three.character.features[0]).toEqual({ ...own, description: 'Rewritten.', uses: { max: 3, used: 1, recharge: 'long', ruled: true } });
    // The table's count clears a ruling the entry kept its scale under; without uses only the text changes.
    const ruled = { ...c, features: [{ ...own, uses: { ...own.uses!, ruled: true } }, dm] };
    expect(addFeature(ruled, tableRow('Indomitable (two uses)', 2)).character.features[0].uses).toEqual(own.uses);
    expect(addFeature(c, tableRow('Indomitable (two uses)')).character.features[0]).toEqual(own);
    // Its own bare name with the table's count, as any name without a count: the number it had, its scale kept, no ruling.
    expect(addFeature(c, { ...tableRow('Indomitable', 2), description: 'Rewritten.' }).character.features[0]).toEqual({ ...own, description: 'Rewritten.' });
  });

  it("a 2024 book Fighter's bare entry its table hasn't counted on the sheet keeps its name under a counted name routed onto it, and the uses the DM gives it there or under its own name are the DM's ruling, the number it had included (F1, D1, D2; srd:rule:fighter-indomitable, srd:rule:fighter-action-surge)", () => {
    // srd:rule:fighter-indomitable: "You can use this feature twice before a Long Rest starting at level 13 and three times
    // before a Long Rest starting at level 17." An older save of a 2024 book's Fighter 13, its features named as the
    // offline parser names them, its table not read (the book's data not on this device, or a table that counts
    // nothing): "Indomitable" without uses yet, "Action Surge" read as 2.
    const bare = indomitable('ind', 'Indomitable', 0, 0, { uses: undefined });
    const surge: Feature = { id: 'surge', name: 'Action Surge', source: 'class', sourceName: 'Fighter 2', description: 'One more action.', uses: { max: 2, used: 1, recharge: 'short' } };
    const c = mira({ classes: [bookFighter(13)], spellcasting: undefined, features: [surge, bare] });
    // Uses where it had none are the DM's ruling, the table's name and count included: the name isn't kept, and nothing
    // here reads the table that would vouch for the number.
    const two = addFeature(c, { ...tableRow('Indomitable (two uses)', 2), description: 'Rewritten.' });
    expect(two.events[0].message).toBe('Updated feature: Indomitable');
    expect(two.character.features).toEqual([surge, { ...bare, description: 'Rewritten.', uses: { max: 2, used: 0, recharge: 'long', ruled: true } }]);
    expect(addFeature(c, { ...tableRow('Indomitable (two uses)'), uses: { max: 3, used: 0, recharge: 'long' } }).character.features[1]).toMatchObject({
      name: 'Indomitable',
      uses: { max: 3, used: 0, recharge: 'long', ruled: true },
    });
    // Action Surge alike, its spent use kept: "(one use)" with one use on the older reading's two, and the older
    // reading's own two under either of the table's names or the entry's own, are the DM's ruling, which no later read
    // of the table takes back to its count (srd:class:fighter table: "| 2 | +2 | Action Surge (one use), Tactical Mind |";
    // srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice before a rest").
    const one = addFeature(c, { ...tableRow('Action Surge (one use)'), uses: { max: 1, used: 0, recharge: 'short' } });
    expect(one.events[0].message).toBe('Updated feature: Action Surge');
    expect(one.character.features[0]).toEqual({ ...surge, description: 'Reroll a failed saving throw.', uses: { max: 1, used: 1, recharge: 'short', ruled: true } });
    for (const name of ['Action Surge (two uses)', 'Action Surge (one use)', 'Action Surge']) {
      const same = addFeature(c, { ...tableRow(name), uses: { max: 2, used: 0, recharge: 'short' } });
      expect(same.events[0].message, name).toBe('Updated feature: Action Surge');
      expect(same.character.features[0], name).toEqual({ ...surge, description: 'Reroll a failed saving throw.', uses: { ...surge.uses!, ruled: true } });
    }
    // The name's count in place of a number the DM left out (the DM's features_add without uses_max: usesFromName) is
    // no ruling: a later read of the table goes on reading the entry. The DM's own number on an entry the name's count
    // filled, the same number, is one (D2).
    expect(addFeature(c, tableRow('Indomitable (one use)', 1), { usesFromName: true }).character.features[1].uses).toEqual({ max: 1, used: 0, recharge: 'long' });
    const held = addFeature(c, tableRow('Indomitable (two uses)', 2), { usesFromName: true }).character;
    expect(held.features[1].uses).toEqual({ max: 2, used: 0, recharge: 'long' });
    expect(addFeature(held, tableRow('Indomitable (two uses)', 2), { usesFromName: true }).character.features[1].uses).toEqual({ max: 2, used: 0, recharge: 'long' });
    expect(addFeature(held, tableRow('Indomitable (two uses)', 2)).character.features[1].uses).toEqual({ max: 2, used: 0, recharge: 'long', ruled: true });
    // The flag alone keeps uses from being the DM's number, whatever name the call gives: no ruling.
    expect(addFeature(c, { ...tableRow('Action Surge'), uses: { max: 2, used: 0, recharge: 'short' } }, { usesFromName: true }).character.features[0].uses).toEqual(surge.uses);
    // A counted name the call records under another source is no row of the class's table: it is added beside, and the
    // class's entry keeps its source, text and uses (F1).
    const beside = addFeature(c, { ...tableRow('Action Surge (two uses)'), source: 'subclass', uses: { max: 2, used: 0, recharge: 'short' } });
    expect(beside.events[0].message).toBe('Gained feature: Action Surge (two uses) (2 uses, recharges on a Short or Long Rest)');
    expect(beside.character.features).toEqual([surge, bare, expect.objectContaining({ name: 'Action Surge (two uses)', source: 'subclass', uses: { max: 2, used: 0, recharge: 'short' } })]);
    // An entry the call moves off the class's features under its own name (another source) is no longer its table's to
    // read: its uses are judged as any rewrite's, the number it had unruled.
    const moved = addFeature(c, { ...tableRow('Action Surge'), source: 'subclass', uses: { max: 2, used: 0, recharge: 'short' } }).character.features[0];
    expect([moved.id, moved.source, moved.uses]).toEqual(['surge', 'subclass', surge.uses]);
    // The SRD Fighter's own bare entry (a hand-made sheet) is no book's: it takes the table's name and its count, no ruling,
    // as before (srd:class:fighter table: "| 13 | +5 | Indomitable (two uses), Studied Attacks |").
    expect(addFeature(fighter([bare]), tableRow('Indomitable (two uses)', 2)).character.features[0]).toEqual({ ...bare, name: 'Indomitable (two uses)', uses: { max: 2, used: 0, recharge: 'long' } });
  });

  it("a counted name recorded under any source but the class's (a boon's, an item's, a subclass's…) is added beside the family: the class's entry keeps its source and text, and grows by the table at 13 and 17 on the level-up dialog's path and the DM's level_up alike (F1; srd:rule:fighter-indomitable, srd:rule:fighter-action-surge)", () => {
    // srd:rule:fighter-indomitable: "You can use this feature twice before a Long Rest starting at level 13 and three times
    // before a Long Rest starting at level 17." srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice
    // before a rest". srd:class:fighter table: "| 9 | +4 | Indomitable (one use), Tactical Master |", "| 13 | +5 |
    // Indomitable (two uses), Studied Attacks |", "| 17 | +6 | Action Surge (two uses), Indomitable (three uses) |".
    const at = (level: number, features: Feature[]) =>
      mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' }], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
    const surge: Feature = { id: 'surge', name: 'Action Surge (one use)', source: 'class', sourceName: 'Fighter 2', description: 'One more action.', uses: { max: 1, used: 0, recharge: 'short' } };
    const ind = indomitable('ind', 'Indomitable (one use)', 1);
    // The table's counted rows as the level-up dialog adds them (the class's own, uses from the name); the DM's level_up
    // gives none, and the level-up joins the SRD table's rows to the family the sheet holds.
    const ROWS: Record<number, [string, number, 'short' | 'long'][]> = {
      9: [['Indomitable (one use)', 1, 'long']],
      13: [['Indomitable (two uses)', 2, 'long']],
      17: [['Action Surge (two uses)', 2, 'short'], ['Indomitable (three uses)', 3, 'long']],
    };
    const rows = (level: number): Omit<Feature, 'id'>[] =>
      (ROWS[level] ?? []).map(([name, max, recharge]) => ({ name, source: 'class', description: 'The class table row.', uses: { max, used: 0, recharge } }));
    const toLevel = (c: Character, to: number, dialog: boolean): Character => {
      let next = c;
      while (next.classes[0].level < to) {
        const level = next.classes[0].level + 1;
        next = levelUp(next, { className: 'Fighter', hpMethod: 'average', ...(dialog ? { newFeatures: rows(level) } : {}) }).character;
      }
      return next;
    };
    const family = (c: Character, base: string) => c.features.filter((f) => f.name.startsWith(base));
    for (const source of ['boon', 'item', 'subclass', 'species', 'background', 'feat', 'homebrew', 'other'] as const) {
      // Fighter 9: the boon "Indomitable (two uses)" with 2 uses.
      const nine = at(9, [surge, ind]);
      const boon = { name: 'Indomitable (two uses)', source, sourceName: 'Granted in play', description: 'A boon of the Lantern-Saint: one more reroll.', uses: { max: 2, used: 0, recharge: 'long' as const } };
      const added = addFeature(nine, boon);
      expect(added.events.map((e) => e.message), source).toEqual(['Gained feature: Indomitable (two uses) (2 uses, recharges on a Long Rest)']);
      expect(added.character.features.slice(0, 2), source).toEqual(nine.features);
      const held = added.character.features[2];
      expect(held, source).toMatchObject(boon);
      for (const dialog of [true, false]) {
        const thirteen = toLevel(added.character, 13, dialog);
        expect(family(thirteen, 'Indomitable'), `${source} ${dialog}`).toEqual([{ ...ind, name: 'Indomitable (two uses)', uses: { max: 2, used: 0, recharge: 'long' } }, held]);
        const seventeen = toLevel(thirteen, 17, dialog);
        expect(family(seventeen, 'Indomitable'), `${source} ${dialog}`).toEqual([{ ...ind, name: 'Indomitable (three uses)', uses: { max: 3, used: 0, recharge: 'long' } }, held]);
        expect(family(seventeen, 'Action Surge'), `${source} ${dialog}`).toEqual([{ ...surge, name: 'Action Surge (two uses)', uses: { max: 2, used: 0, recharge: 'short' } }]);
      }
      // Fighter 5: an item's "Action Surge (two uses)" with 2 uses; the class's Action Surge alone grows at 17.
      const five = at(5, [surge]);
      const item = { name: 'Action Surge (two uses)', source, sourceName: 'Granted in play', description: 'The Lantern of the Second Breath.', uses: { max: 2, used: 0, recharge: 'short' as const } };
      const withItem = addFeature(five, item);
      expect(withItem.events.map((e) => e.message), source).toEqual(['Gained feature: Action Surge (two uses) (2 uses, recharges on a Short or Long Rest)']);
      expect(withItem.character.features[0], source).toEqual(surge);
      for (const dialog of [true, false]) {
        const seventeen = toLevel(withItem.character, 17, dialog);
        expect(family(seventeen, 'Action Surge'), `${source} ${dialog}`).toEqual([{ ...surge, name: 'Action Surge (two uses)', uses: { max: 2, used: 0, recharge: 'short' } }, withItem.character.features[1]]);
      }
    }
    // The same calls recorded as the class's (source "class") rewrite the family's one entry, as before.
    const routed = addFeature(at(9, [surge, ind]), { name: 'Indomitable (two uses)', source: 'class', sourceName: 'Granted in play', description: 'Twice now.', uses: { max: 2, used: 0, recharge: 'long' } });
    expect(routed.events[0].message).toBe('Updated feature: Indomitable (one use) → Indomitable (two uses)');
    expect(family(routed.character, 'Indomitable').map((f) => [f.id, f.name, f.source, f.sourceName, f.uses?.max])).toEqual([['ind', 'Indomitable (two uses)', 'class', 'Fighter 9', 2]]);
  });

  it("a boon kept beside the class's entry shares its name from Fighter 13: features_add of the name under the boon's source rewrites the boon and under the class's the class's entry, each named by its label, a use by the boon's label spends the boon, and the class's entry has 3 at 17 beside the boon's 2 on the level-up dialog's path and the DM's level_up alike (F1/D1; srd:rule:fighter-indomitable)", () => {
    // srd:rule:fighter-indomitable: "You can use this feature twice before a Long Rest starting at level 13 and three times
    // before a Long Rest starting at level 17." srd:class:fighter table: "| 13 | +5 | Indomitable (two uses), Studied
    // Attacks |" and "| 17 | +6 | Action Surge (two uses), Indomitable (three uses) |".
    const at = (level: number, features: Feature[]) =>
      mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' }], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
    // The table's Indomitable rows as the level-up dialog adds them; the DM's level_up gives none.
    const ROWS: Record<number, [string, number]> = { 13: ['Indomitable (two uses)', 2], 17: ['Indomitable (three uses)', 3] };
    const toLevel = (c: Character, to: number, dialog: boolean): Character => {
      let next = c;
      while (next.classes[0].level < to) {
        const row = ROWS[next.classes[0].level + 1];
        const newFeatures = dialog && row ? [{ name: row[0], source: 'class' as const, description: 'The class table row.', uses: { max: row[1], used: 0, recharge: 'long' as const } }] : [];
        next = levelUp(next, { className: 'Fighter', hpMethod: 'average', newFeatures }).character;
      }
      return next;
    };
    const family = (c: Character) => c.features.filter((f) => f.name.startsWith('Indomitable'));
    const boon = { name: 'Indomitable (two uses)', source: 'boon' as const, sourceName: 'Granted in play', description: 'A boon of the Lantern-Saint.', uses: { max: 2, used: 0, recharge: 'long' as const } };
    // The class's entry as the level-up dialog adds it ("Fighter 9"), on both paths, and as the DM records the level_up
    // reminder's row (features_add: "Granted in play", as the boon is), on the DM's path, where the labels name the
    // sources.
    const HEROES = [
      { own: indomitable('ind', 'Indomitable (one use)', 1), paths: [true, false], boonLabel: 'Indomitable (two uses) (Granted in play)', classLabel: 'Indomitable (two uses) (Fighter 9)' },
      { own: indomitable('ind', 'Indomitable (one use)', 1, 0, { sourceName: 'Granted in play' }), paths: [false], boonLabel: 'Indomitable (two uses) (boon)', classLabel: 'Indomitable (two uses) (class)' },
    ];
    const renewedAt13: Character[] = [];
    for (const { own, paths, boonLabel, classLabel } of HEROES) {
      const nine = addFeature(at(9, [own]), boon);
      expect(nine.events.map((e) => e.message), own.sourceName).toEqual(['Gained feature: Indomitable (two uses) (2 uses, recharges on a Long Rest)']);
      const gift = nine.character.features[1];
      const grown = { ...own, name: 'Indomitable (two uses)', uses: { max: 2, used: 0, recharge: 'long' as const } };
      for (const dialog of paths) {
        const why = `${own.sourceName} ${dialog ? 'dialog' : 'level_up'}`;
        const thirteen = toLevel(nine.character, 13, dialog);
        expect(family(thirteen), why).toEqual([grown, gift]);
        // The boon's own call changes the boon, and the result names it as a use takes it.
        const retold = addFeature(thirteen, { ...boon, description: 'The Lantern-Saint renews the boon.' });
        expect(retold.events.map((e) => e.message), why).toEqual([`Updated feature: ${boonLabel}`]);
        const renewed = { ...gift, description: 'The Lantern-Saint renews the boon.' };
        expect(family(retold.character), why).toEqual([grown, renewed]);
        if (!dialog) renewedAt13.push(retold.character);
        // The class's call changes the class's entry.
        const restated = addFeature(retold.character, { name: 'Indomitable (two uses)', source: 'class', sourceName: 'Granted in play', description: 'Twice before a Long Rest.' });
        expect(restated.events.map((e) => e.message), why).toEqual([`Updated feature: ${classLabel}`]);
        expect(family(restated.character), why).toEqual([{ ...grown, description: 'Twice before a Long Rest.' }, renewed]);
        // Fighter 17: the class's one entry has the table's 3, the boon its own 2.
        expect(family(toLevel(retold.character, 17, dialog)), why).toEqual([{ ...grown, name: 'Indomitable (three uses)', uses: { max: 3, used: 0, recharge: 'long' } }, renewed]);
      }
    }
    // A use by the boon's label spends the boon, its class namesake untouched: "(Granted in play)" beside the dialog's
    // "Fighter 9" entry, "(boon)" beside the DM's.
    const [dialogMade, dmRecorded] = renewedAt13;
    expect(family(useFeature(dialogMade, HEROES[0].boonLabel).character).map((f) => f.uses?.used)).toEqual([0, 1]);
    expect(family(useFeature(dmRecorded, HEROES[1].boonLabel).character).map((f) => f.uses?.used)).toEqual([0, 1]);
    // One entry of the name is rewritten whatever the call's source, as before: the class's own on a Fighter 13.
    const lone = indomitable('ind', 'Indomitable (two uses)', 2, 1);
    const taken = addFeature(at(13, [lone]), boon);
    expect(taken.events.map((e) => e.message)).toEqual(['Updated feature: Indomitable (two uses)']);
    expect(taken.character.features).toEqual([{ ...lone, source: 'boon', description: 'A boon of the Lantern-Saint.', uses: { max: 2, used: 1, recharge: 'long' } }]);
    // Of several of the name, none under the call's source: the first is rewritten, as before (an item's call here).
    const both = toLevel(addFeature(at(9, [indomitable('ind', 'Indomitable (one use)', 1)]), boon).character, 13, false);
    expect(addFeature(both, { ...boon, source: 'item', description: 'By the DM.' }).character.features.map((f) => [f.source, f.description])).toEqual([
      ['item', 'By the DM.'],
      ['boon', 'A boon of the Lantern-Saint.'],
    ]);
    // A name no table counts alike: the DM's boon "Tactical Mind" on a Fighter 1, beside which the level-up dialog adds the
    // class's own at 2 (srd:class:fighter table: "| 2 | +2 | Action Surge (one use), Tactical Mind |";
    // srd:rule:fighter-tactical-mind: "When you fail an ability check, you can expend a use of your Second Wind to push
    // yourself toward success"). The class's call changes the class's entry, though the boon comes first; the boon's call,
    // the boon.
    const mind = { name: 'Tactical Mind', source: 'boon' as const, sourceName: 'Granted in play', description: 'A boon of the Lantern-Saint.' };
    const one = addFeature(at(1, []), mind).character;
    const two = levelUp(one, { className: 'Fighter', hpMethod: 'average', newFeatures: [{ name: 'Tactical Mind', source: 'class', description: 'Second Wind for a failed check.' }] }).character;
    const [gifted, taught] = two.features;
    expect([gifted.source, taught.source, taught.sourceName]).toEqual(['boon', 'class', 'Fighter 2']);
    const byClass = addFeature(two, { name: 'Tactical Mind', source: 'class', sourceName: 'Granted in play', description: 'A d10 on a failed ability check.' });
    expect(byClass.events.map((e) => e.message)).toEqual(['Updated feature: Tactical Mind (Fighter 2)']);
    expect(byClass.character.features).toEqual([gifted, { ...taught, description: 'A d10 on a failed ability check.' }]);
    const byBoon = addFeature(two, { ...mind, description: 'The boon retold.' });
    expect(byBoon.events.map((e) => e.message)).toEqual(['Updated feature: Tactical Mind (Granted in play)']);
    expect(byBoon.character.features).toEqual([{ ...gifted, description: 'The boon retold.' }, taught]);
    // Of several under the call's source, the first, as before: a feat taken twice (srd:feat:skilled: "You can take this
    // feat more than once").
    const taking = (id: string, level: number): Feature => ({ id, name: 'Skilled', source: 'feat', sourceName: `Ability Score Improvement (Fighter ${level})`, description: 'Three skills.' });
    const twice = addFeature(at(8, [taking('first', 4), taking('second', 8)]), { name: 'Skilled', source: 'feat', sourceName: 'Granted in play', description: 'Three tools.' });
    expect(twice.events.map((e) => e.message)).toEqual(['Updated feature: Skilled (Ability Score Improvement (Fighter 4))']);
    expect(twice.character.features.map((f) => [f.id, f.description])).toEqual([['first', 'Three tools.'], ['second', 'Three skills.']]);
  });

  it("a counted name routed onto its family's entry with a number that isn't the name's count keeps the entry's own name: the number the entry had keeps how it grows, another is the DM's ruling; given the name's own count, the entry takes the name, as before (F2; srd:rule:fighter-action-surge, srd:rule:fighter-indomitable)", () => {
    // srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice before a rest". srd:rule:fighter-indomitable:
    // "You can use this feature twice before a Long Rest starting at level 13 and three times before a Long Rest starting
    // at level 17." The DM restates a feature under the name it first recorded it by.
    const at = (level: number, features: Feature[]) =>
      mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' }], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
    const surge = (name: string, max: number, used = 0): Feature => ({ id: 'surge', name, source: 'class', sourceName: 'Fighter 2', description: 'One more action.', uses: { max, used, recharge: 'short' } });
    const call = (name: string, max: number, recharge: 'short' | 'long') => ({ name, source: 'class' as const, sourceName: 'Granted in play', description: 'The DM restates it.', uses: { max, used: 0, recharge } });
    const seventeen = at(17, [surge('Action Surge (two uses)', 2, 1), indomitable('ind', 'Indomitable (three uses)', 3)]);
    // "Action Surge (one use)" with 2 at Fighter 17: the entry keeps its name, its 2 and its spent use, no ruling.
    const restated = addFeature(seventeen, call('Action Surge (one use)', 2, 'short'));
    expect(restated.events.map((e) => e.message)).toEqual(['Updated feature: Action Surge (two uses)']);
    expect(restated.character.features).toEqual([{ ...seventeen.features[0], description: 'The DM restates it.' }, seventeen.features[1]]);
    // "Indomitable (two uses)" with 3 at Fighter 17 alike.
    const thrice = addFeature(seventeen, call('Indomitable (two uses)', 3, 'long'));
    expect(thrice.events.map((e) => e.message)).toEqual(['Updated feature: Indomitable (three uses)']);
    expect(thrice.character.features[1]).toEqual({ ...seventeen.features[1], description: 'The DM restates it.' });
    // Another number under the older name is the DM's ruling, on the entry under its own name.
    expect(addFeature(seventeen, call('Action Surge (one use)', 3, 'short')).character.features[0]).toEqual({ ...seventeen.features[0], description: 'The DM restates it.', uses: { max: 3, used: 1, recharge: 'short', ruled: true } });
    // The name's own count is the name's: the entry takes it, unruled, as before ("Action Surge (one use)" with 1).
    const once = addFeature(seventeen, call('Action Surge (one use)', 1, 'short'));
    expect(once.events.map((e) => e.message)).toEqual(['Updated feature: Action Surge (two uses) → Action Surge (one use)']);
    expect(once.character.features[0]).toEqual({ ...seventeen.features[0], name: 'Action Surge (one use)', description: 'The DM restates it.', uses: { max: 1, used: 1, recharge: 'short' } });
    // "Indomitable (one use)" with 2 at Fighter 13 keeps "(two uses)" and its 2, which the table grows to 3 at 17 on the
    // level-up dialog's path and the DM's level_up alike.
    const thirteen = at(13, [surge('Action Surge (one use)', 1), indomitable('ind', 'Indomitable (two uses)', 2)]);
    const older = addFeature(thirteen, call('Indomitable (one use)', 2, 'long'));
    expect(older.events.map((e) => e.message)).toEqual(['Updated feature: Indomitable (two uses)']);
    expect(older.character.features[1]).toEqual({ ...thirteen.features[1], description: 'The DM restates it.' });
    for (const dialog of [true, false]) {
      let c = older.character;
      while (c.classes[0].level < 17) {
        const level = c.classes[0].level + 1;
        const newFeatures = dialog && level === 17 ? [{ name: 'Indomitable (three uses)', source: 'class' as const, description: 'The class table row.', uses: { max: 3, used: 0, recharge: 'long' as const } }] : [];
        c = levelUp(c, { className: 'Fighter', hpMethod: 'average', newFeatures }).character;
        expect(c.features.find((f) => f.id === 'ind'), `${dialog} ${level}`).toMatchObject(level < 17 ? { name: 'Indomitable (two uses)', uses: { max: 2 } } : { name: 'Indomitable (three uses)', uses: { max: 3 } });
      }
    }
    // A higher name with a number not its count: the entry keeps its own name too, so no name counts more than it holds.
    expect(addFeature(thirteen, call('Indomitable (three uses)', 2, 'long')).character.features[1]).toEqual({ ...thirteen.features[1], description: 'The DM restates it.' });
    expect(addFeature(at(5, [surge('Action Surge (one use)', 1)]), call('Action Surge (two uses)', 1, 'short')).character.features[0]).toEqual({ ...surge('Action Surge (one use)', 1), description: 'The DM restates it.' });
    // With the name's count, as before: "Indomitable (three uses)" with 3 at Fighter 13 renames the entry, unruled.
    expect(addFeature(thirteen, call('Indomitable (three uses)', 3, 'long')).character.features[1]).toEqual({ ...thirteen.features[1], name: 'Indomitable (three uses)', description: 'The DM restates it.', uses: { max: 3, used: 0, recharge: 'long' } });
  });

  it("the count rule holds for the DM's own entries, an entry without uses and a family only the class's own counted names count: an older counted name given another number keeps the entry's name (round 7; srd:rule:fighter-action-surge, srd:rule:fighter-indomitable)", () => {
    // srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice before a rest". srd:rule:fighter-indomitable:
    // "You can use this feature twice before a Long Rest starting at level 13 and three times before a Long Rest starting
    // at level 17."
    const at = (level: number, features: Feature[], classes?: Character['classes']) =>
      mira({ classes: classes ?? [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' }], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
    const granted = (id: string, name: string, uses?: Feature['uses']): Feature => ({ id, name, source: 'class', sourceName: 'Granted in play', description: 'As the table says.', ...(uses ? { uses } : {}) });
    const call = (name: string, max: number, recharge: 'short' | 'long') => ({ name, source: 'class' as const, sourceName: 'Granted in play', description: 'The DM restates it.', uses: { max, used: 0, recharge } });
    const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
    // The DM's "Granted in play" entries, as level_up's reminders have the DM record them: today's 2 under the older name.
    const dm17 = at(17, [granted('surge', 'Action Surge (two uses)', { max: 2, used: 1, recharge: 'short' }), granted('ind', 'Indomitable (three uses)', { max: 3, used: 0, recharge: 'long' })]);
    const surged = addFeature(dm17, call('Action Surge (one use)', 2, 'short'));
    expect(messages(surged)).toEqual(['Updated feature: Action Surge (two uses)']);
    expect(surged.character.features[0]).toEqual({ ...dm17.features[0], description: 'The DM restates it.' });
    const thrice = addFeature(dm17, call('Indomitable (two uses)', 3, 'long'));
    expect(messages(thrice)).toEqual(['Updated feature: Indomitable (three uses)']);
    expect(thrice.character.features[1]).toEqual({ ...dm17.features[1], description: 'The DM restates it.' });
    // The DM's entry recorded without uses: it keeps its name, and any number given it is the DM's ruling.
    const bare13 = at(13, [granted('ind', 'Indomitable (two uses)')]);
    const given = addFeature(bare13, call('Indomitable (one use)', 2, 'long'));
    expect(messages(given)).toEqual(['Updated feature: Indomitable (two uses)']);
    expect(given.character.features[0]).toEqual({ ...bare13.features[0], description: 'The DM restates it.', uses: { max: 2, used: 0, recharge: 'long', ruled: true } });
    // An older-edition book's Fighter doesn't stand in for the SRD's, so only its own entry's counted name makes the family:
    // the same rule keeps that entry's name.
    const book = {
      classId: 'lib:lantern:class:fighter',
      name: 'Fighter',
      level: 13,
      hitDie: 10 as const,
      casterType: 'none' as const,
      ref: { sourceId: 'lantern', sourceTitle: 'The Lanternfall Handbook', entryId: 'lib:lantern:class:fighter', kind: 'class' as const, entryName: 'Fighter', format: '2014' as const, textHash: '', textCopied: false },
    };
    const older = at(13, [indomitable('ind', 'Indomitable (two uses)', 2, 1, { sourceName: 'Fighter 13' })], [book]);
    const restated = addFeature(older, call('Indomitable (one use)', 2, 'long'));
    expect(messages(restated)).toEqual(['Updated feature: Indomitable (two uses)']);
    expect(restated.character.features[0]).toEqual({ ...older.features[0], description: 'The DM restates it.' });
  });

  it("a class feature's counted name goes to its family past an entry of that name under another source: the family's entry takes the call and the boon or item keeps its source, text and uses, or with no entry of the family the class's joins beside it, as the level-up dialog adds it; a call under another source, a name without a count and a class whose family no one counts are as before (F1; srd:rule:fighter-indomitable, srd:rule:fighter-action-surge)", () => {
    // srd:rule:fighter-indomitable: "You can use this feature twice before a Long Rest starting at level 13 and three times
    // before a Long Rest starting at level 17." srd:rule:fighter-action-surge: "Starting at level 17, you can use it twice
    // before a rest". The DM restates the class's feature by a name a boon or an item holds.
    const at = (level: number, features: Feature[], classes?: Character['classes']) =>
      mira({ classes: classes ?? [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' }], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
    const gift = (name: string, max: number, source: Feature['source'] = 'boon', recharge: 'short' | 'long' = 'long'): Feature => ({ id: 'gift', name, source, sourceName: 'Granted in play', description: 'A boon of the Lantern-Saint.', uses: { max, used: 1, recharge } });
    const call = (name: string, max: number, recharge: 'short' | 'long' = 'long') => ({ name, source: 'class' as const, sourceName: 'Granted in play', description: 'The DM restates it.', uses: { max, used: 0, recharge } });
    const surge = (name: string, max: number): Feature => ({ id: 'surge', name, source: 'class', sourceName: 'Fighter 2', description: 'One more action.', uses: { max, used: 0, recharge: 'short' } });
    const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
    // Fighter 17, the class's "Indomitable (three uses)" (the level-up dialog's, or the DM's) beside a boon "Indomitable (two
    // uses)" from Fighter 9: the class's call of the boon's name with 3 changes the class's entry, which keeps its name.
    for (const own of [indomitable('ind', 'Indomitable (three uses)', 3, 1), indomitable('ind', 'Indomitable (three uses)', 3, 1, { sourceName: 'Granted in play' })]) {
      const seventeen = at(17, [own, gift('Indomitable (two uses)', 2)]);
      const r = addFeature(seventeen, call('Indomitable (two uses)', 3));
      expect(messages(r), own.sourceName).toEqual(['Updated feature: Indomitable (three uses)']);
      expect(r.character.features, own.sourceName).toEqual([{ ...own, description: 'The DM restates it.' }, seventeen.features[1]]);
    }
    // Fighter 10 alike: "Indomitable (two uses)" with 1 keeps the class's "Indomitable (one use)", and the boon its 2. The
    // table grows the class's entry into the boon's name at 13 and past it at 17, whichever path levels it.
    const ten = at(10, [indomitable('ind', 'Indomitable (one use)', 1), gift('Indomitable (two uses)', 2)]);
    const restated = addFeature(ten, call('Indomitable (two uses)', 1));
    expect(messages(restated)).toEqual(['Updated feature: Indomitable (one use)']);
    expect(restated.character.features).toEqual([{ ...ten.features[0], description: 'The DM restates it.' }, ten.features[1]]);
    for (const dialog of [true, false]) {
      let c = restated.character;
      while (c.classes[0].level < 17) {
        const level = c.classes[0].level + 1;
        const row = { 13: ['Indomitable (two uses)', 2], 17: ['Indomitable (three uses)', 3] }[level] as [string, number] | undefined;
        const newFeatures = dialog && row ? [{ name: row[0], source: 'class' as const, description: 'The class table row.', uses: { max: row[1], used: 0, recharge: 'long' as const } }] : [];
        c = levelUp(c, { className: 'Fighter', hpMethod: 'average', newFeatures }).character;
        const count = level < 13 ? 1 : level < 17 ? 2 : 3;
        expect(c.features.map((f) => [f.id, f.source, f.uses?.max]), `${dialog ? 'dialog' : 'level_up'} ${level}`).toEqual([['ind', 'class', count], ['gift', 'boon', 2]]);
      }
    }
    // Fighter 9 holding only a boon "Indomitable (one use)" (from Fighter 5): no entry of the family, so the class's joins
    // beside the boon, as the level-up dialog adds it; the class's later call of that name changes the class's.
    const nine = at(9, [gift('Indomitable (one use)', 1)]);
    const joined = addFeature(nine, call('Indomitable (one use)', 1));
    expect(messages(joined)).toEqual(['Gained feature: Indomitable (one use) (1 use, recharges on a Long Rest), beside Indomitable (one use) (boon)']);
    const [boon, cls] = joined.character.features;
    expect(boon).toEqual(nine.features[0]);
    expect(cls).toEqual({ ...call('Indomitable (one use)', 1), id: expect.any(String) });
    const again = addFeature(joined.character, { ...call('Indomitable (one use)', 1), description: 'Once before a Long Rest.' });
    expect(messages(again)).toEqual(['Updated feature: Indomitable (one use) (class)']);
    expect(again.character.features).toEqual([boon, { ...cls, description: 'Once before a Long Rest.' }]);
    // Fighter 17, an item's "Action Surge (one use)" (from Fighter 1) beside the class's "Action Surge (two uses)":
    // "Action Surge (one use)" with 2 changes the class's, its name and recharge kept.
    const surging = at(17, [gift('Action Surge (one use)', 1, 'item', 'short'), surge('Action Surge (two uses)', 2)]);
    const surged = addFeature(surging, call('Action Surge (one use)', 2, 'short'));
    expect(messages(surged)).toEqual(['Updated feature: Action Surge (two uses)']);
    expect(surged.character.features).toEqual([surging.features[0], { ...surging.features[1], description: 'The DM restates it.' }]);
    // A family the class's own counted entry makes (no table counting it by name): a Cleric 6's own "Channel Divinity (3
    // uses)" beside the DM's boon "Channel Divinity (2 uses)" (srd:rule:cleric-channel-divinity: "You can use this class's
    // Channel Divinity twice.").
    const cleric = at(6, [{ id: 'cd', name: 'Channel Divinity (3 uses)', source: 'class', sourceName: 'Cleric 6', description: 'Divine Spark or Turn Undead.', uses: { max: 3, used: 0, recharge: 'short' } }, gift('Channel Divinity (2 uses)', 2)], [{ classId: 'srd:class:cleric', name: 'Cleric', level: 6, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }]);
    const divine = addFeature(cleric, call('Channel Divinity (2 uses)', 3, 'short'));
    expect(messages(divine)).toEqual(['Updated feature: Channel Divinity (3 uses)']);
    expect(divine.character.features).toEqual([{ ...cleric.features[0], description: 'The DM restates it.' }, cleric.features[1]]);

    // As before: the boon's own call changes the boon, and another source's call the boon when it is the only one of the name.
    const seventeen = at(17, [indomitable('ind', 'Indomitable (three uses)', 3), gift('Indomitable (two uses)', 2)]);
    const retold = addFeature(seventeen, { ...gift('Indomitable (two uses)', 2), id: undefined, description: 'The boon retold.' });
    expect(messages(retold)).toEqual(['Updated feature: Indomitable (two uses)']);
    expect(retold.character.features).toEqual([seventeen.features[0], { ...seventeen.features[1], description: 'The boon retold.', uses: { max: 2, used: 1, recharge: 'long' } }]);
    expect(addFeature(seventeen, { ...gift('Indomitable (two uses)', 2, 'item'), id: undefined }).character.features.map((f) => [f.id, f.source])).toEqual([
      ['ind', 'class'],
      ['gift', 'item'],
    ]);
    // A class no table or entry counts the family for, the Wizard Mira: the class's call changes her boon, as before.
    const wizard = mira({ features: [gift('Indomitable (two uses)', 2)] });
    const taken = addFeature(wizard, call('Indomitable (two uses)', 2));
    expect(messages(taken)).toEqual(['Updated feature: Indomitable (two uses)']);
    expect(taken.character.features).toEqual([{ ...wizard.features[0], source: 'class', description: 'The DM restates it.', uses: { max: 2, used: 1, recharge: 'long' } }]);
    // A name without a count, as before: the class's call changes a Fighter 2's lone boon "Tactical Mind" (srd:class:fighter
    // table: "| 2 | +2 | Action Surge (one use), Tactical Mind |").
    const mind = at(2, [{ id: 'mind', name: 'Tactical Mind', source: 'boon', sourceName: 'Granted in play', description: 'A boon of the Lantern-Saint.' }]);
    const told = addFeature(mind, { name: 'Tactical Mind', source: 'class', sourceName: 'Granted in play', description: 'Second Wind for a failed check.' });
    expect(messages(told)).toEqual(['Updated feature: Tactical Mind']);
    expect(told.character.features).toEqual([{ ...mind.features[0], source: 'class', description: 'Second Wind for a failed check.' }]);
  });

  it("a species trait's or a subclass feature's entry of a class feature's counted name keeps its source too, though on the class's side of the feat line: the class's call changes the family's entry, or joins beside the namesake while the sheet holds none (srd:rule:fighter-indomitable)", () => {
    // srd:rule:fighter-indomitable: "You can use this feature twice before a Long Rest starting at level 13 and three times
    // before a Long Rest starting at level 17." A Mothkin's invented trait, or a subclass's, named like the class's row.
    const at = (level: number, features: Feature[]) =>
      mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level, hitDie: 10, casterType: 'none' }], hitDice: [{ die: 10, total: level, spent: 0 }], spellcasting: undefined, features });
    const SOURCE_NAMES = { species: 'Mothkin', subclass: 'Champion 7' } as const;
    const namesake = (source: 'species' | 'subclass', name: string): Feature => ({ id: 'namesake', name, source, sourceName: SOURCE_NAMES[source], description: 'An invented gift.', uses: { max: 1, used: 1, recharge: 'long' } });
    const call = (name: string, max: number) => ({ name, source: 'class' as const, sourceName: 'Granted in play', description: 'The DM restates it.', uses: { max, used: 0, recharge: 'long' as const } });
    const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
    for (const source of ['species', 'subclass'] as const) {
      // Fighter 9 holding no entry of the family: the class's joins beside the namesake, which keeps its source and use spent.
      const nine = at(9, [namesake(source, 'Indomitable (one use)')]);
      expect(featureToRewrite(nine, { name: 'Indomitable (one use)', source: 'class' }), source).toBeUndefined();
      const joined = addFeature(nine, call('Indomitable (one use)', 1));
      expect(messages(joined), source).toEqual([`Gained feature: Indomitable (one use) (1 use, recharges on a Long Rest), beside Indomitable (one use) (${SOURCE_NAMES[source]})`]);
      expect(joined.character.features, source).toEqual([nine.features[0], { ...call('Indomitable (one use)', 1), id: expect.any(String) }]);
      // Fighter 17: the class's call of the namesake's name changes the class's "Indomitable (three uses)".
      const seventeen = at(17, [indomitable('ind', 'Indomitable (three uses)', 3), namesake(source, 'Indomitable (two uses)')]);
      const r = addFeature(seventeen, call('Indomitable (two uses)', 3));
      expect(messages(r), source).toEqual(['Updated feature: Indomitable (three uses)']);
      expect(r.character.features, source).toEqual([{ ...seventeen.features[0], description: 'The DM restates it.' }, seventeen.features[1]]);
      // The namesake's own call changes the namesake, as before.
      expect(featureToRewrite(seventeen, { name: 'Indomitable (two uses)', source })?.id, source).toBe('namesake');
    }
  });

  it("only a class feature's count in its name is its table's row: another feature named with a count, given that count over its own, is the DM's ruling as any rewrite is (srd:class:fighter table: \"| 13 | +5 | Indomitable (two uses), Studied Attacks |\")", () => {
    // An invented species trait the DM named with a count: no class table names it, so its name vouches for no number.
    const luck: Feature = { id: 'luck', name: 'Lantern Luck (2 uses)', source: 'species', sourceName: 'Mothkin', description: 'Luck of the lamp.', uses: { max: 1, used: 0, recharge: 'long' } };
    const given = { name: 'Lantern Luck (2 uses)', source: 'species' as const, description: 'Twice now.', uses: { max: 2, used: 0, recharge: 'long' as const } };
    expect(addFeature(mira({ features: [luck] }), given).character.features[0].uses).toEqual({ max: 2, used: 0, recharge: 'long', ruled: true });
    // A class feature of that name given its name's count is the table's row: no ruling.
    const own: Feature = { ...luck, source: 'class', sourceName: 'Fighter 9' };
    expect(addFeature(fighter([own]), { ...given, source: 'class' }).character.features[0].uses).toEqual({ max: 2, used: 0, recharge: 'long' });
  });

  it('reads its table: a book class standing in for one that counts the base by name, its own entry, named with the base alone (readsItsTable)', () => {
    const own = (name: string, sourceName = 'Fighter 9') => indomitable('x', name, 1, 0, { sourceName });
    const classes = [bookFighter(13)];
    expect(readsItsTable(own('Indomitable'), classes)).toBe(true);
    expect(readsItsTable(own('Action Surge', 'Fighter 2'), classes)).toBe(true);
    // A name with a count, another parenthetical, the DM's entry, another base, another class: not read by the table.
    expect(readsItsTable(own('Indomitable (two uses)'), classes)).toBe(false);
    expect(readsItsTable(own('Indomitable (Tactical)'), classes)).toBe(false);
    expect(readsItsTable(own('Indomitable', 'Granted in play'), classes)).toBe(false);
    expect(readsItsTable(own('Second Wind', 'Fighter 1'), classes)).toBe(false);
    expect(readsItsTable(own('Indomitable', 'Wizard 1'), [...classes, { classId: 'srd:class:wizard', name: 'Wizard', level: 1, hitDie: 6, casterType: 'full' }])).toBe(false);
    // The SRD Fighter's own (its table names its entries with their counts), and an older-edition book's (no stand-in).
    expect(readsItsTable(own('Indomitable'), [{ classId: 'srd:class:fighter', name: 'Fighter', level: 13, hitDie: 10, casterType: 'none' }])).toBe(false);
    expect(readsItsTable(own('Indomitable'), [bookFighter(13, '2014')])).toBe(false);
  });

  it('a name without a count, a feat of the name, or a DM entry named otherwise is added beside it as before', () => {
    const c = fighter([indomitable('ind', 'Indomitable (one use)', 1)]);
    const bare = addFeature(c, tableRow('Indomitable', 2));
    expect(bare.character.features.map((f) => f.name)).toEqual(['Indomitable (one use)', 'Indomitable']);
    expect(bare.events[0].message).toBe('Gained feature: Indomitable (2 uses, recharges on a Long Rest)');
    const feat = addFeature(c, { ...tableRow('Indomitable (two uses)', 2), source: 'feat' });
    expect(feat.character.features.map((f) => [f.name, f.source])).toEqual([['Indomitable (one use)', 'class'], ['Indomitable (two uses)', 'feat']]);
    // The DM's "Indomitable (2/LR)" is no family entry: a counted name doesn't rewrite it.
    const house = fighter([{ ...indomitable('house', 'Indomitable (2/LR)', 2), sourceName: 'Granted in play' }]);
    expect(addFeature(house, tableRow('Indomitable (two uses)', 2)).character.features.map((f) => f.name)).toEqual(['Indomitable (2/LR)', 'Indomitable (two uses)']);
    // Nor is the class's own entry of another parenthetical (a DM's homebrew "Indomitable (Tactical)" from level_up).
    const tactical = fighter([{ ...indomitable('tac', 'Indomitable (Tactical)', 1), sourceName: 'Fighter 13' }]);
    expect(addFeature(tactical, tableRow('Indomitable (two uses)', 2)).character.features.map((f) => f.name)).toEqual(['Indomitable (Tactical)', 'Indomitable (two uses)']);
  });

  it("a DM's second counted label beside a class feature no table counts by name is added beside too: the class's entry and the DM's first label stay as they are (srd:class:barbarian Rage, srd:class:druid Wild Shape)", () => {
    // srd:class:barbarian, Rage: "You can enter your Rage the number of times shown for your Barbarian level in the Rages
    // column of the Barbarian Features table."; srd:class:druid, Wild Shape: "You can use Wild Shape twice." and "You gain
    // additional uses when you reach certain Druid levels, as shown in the Wild Shape column of the Druid Features table."
    // Neither table names the feature with a count, so the DM's labels are entries of their own, as they always were.
    const rages = { by: 'table' as const, className: 'Barbarian', values: [2, 2, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 6, 6, 6] };
    const rage: Feature = { id: 'rage', name: 'Rage', source: 'class', sourceName: 'Barbarian 1', description: 'The SRD text.', uses: { max: 3, used: 1, recharge: 'long', scale: rages } };
    const barbarian = mira({ classes: [{ classId: 'srd:class:barbarian', name: 'Barbarian', level: 3, hitDie: 12, casterType: 'none' }], spellcasting: undefined, features: [rage] });
    const shapes = { by: 'table' as const, className: 'Druid', values: [0, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4] };
    const shape: Feature = { id: 'ws', name: 'Wild Shape', source: 'class', sourceName: 'Druid 2', description: 'The SRD text.', uses: { max: 2, used: 0, recharge: 'long', scale: shapes } };
    const druid = mira({ classes: [{ classId: 'srd:class:druid', name: 'Druid', level: 2, hitDie: 8, casterType: 'full', spellcastingAbility: 'wis' }], features: [shape] });
    for (const [hero, base, first, second] of [
      [barbarian, 'Rage', 3, 4],
      [druid, 'Wild Shape', 2, 3],
    ] as const) {
      const one = addFeature(hero, { ...tableRow(`${base} (${first} uses)`, first), description: 'The DM label.' }).character;
      const two = addFeature(one, { ...tableRow(`${base} (${second} uses)`, second), description: 'The DM label, later.' });
      expect(two.events[0].message).toBe(`Gained feature: ${base} (${second} uses) (${second} uses, recharges on a Long Rest)`);
      expect(two.character.features.slice(0, 2)).toEqual(one.features);
      expect(two.character.features[0]).toEqual(hero.features[0]);
      expect(two.character.features.map((f) => [f.name, f.sourceName, f.uses?.max])).toEqual([
        [base, hero.features[0].sourceName, hero.features[0].uses?.max],
        [`${base} (${first} uses)`, 'Granted in play', first],
        [`${base} (${second} uses)`, 'Granted in play', second],
      ]);
    }
  });

  it("Mira's own Channel Divinity labels stay two entries, and a use by a count the sheet doesn't hold warns as always (srd:rule:cleric-channel-divinity)", () => {
    // srd:rule:cleric-channel-divinity: "You can use this class's Channel Divinity twice." A Wizard's (the DM's grant) is
    // the DM's own: no class of Mira's counts it by name.
    const granted = (name: string, max: number): Feature => ({ id: name, name, source: 'class', sourceName: 'Granted in play', description: 'A boon.', uses: { max, used: 0, recharge: 'long' } });
    const c = mira({ features: [...mira().features, granted('Channel Divinity (2 uses)', 2)] });
    const r = addFeature(c, { ...tableRow('Channel Divinity (3 uses)', 3), description: 'A greater boon.' });
    expect(r.events[0].message).toBe('Gained feature: Channel Divinity (3 uses) (3 uses, recharges on a Long Rest)');
    expect(r.character.features.slice(-2).map((f) => [f.name, f.uses?.max])).toEqual([
      ['Channel Divinity (2 uses)', 2],
      ['Channel Divinity (3 uses)', 3],
    ]);
    const used = useFeature(c, 'Channel Divinity (1 use)');
    expect(used.character).toBe(c);
    expect(used.events[0]).toMatchObject({ type: 'warning', message: 'No feature named "Channel Divinity (1 use)".' });
  });

  it("a DM-only Fighter (every entry from features_add): the Fighter's table counts the family by name, so lookups and the table's names find the DM's entries", () => {
    const granted = (id: string, name: string, max: number, used = 0): Feature => ({ ...indomitable(id, name, max, used), sourceName: 'Granted in play' });
    const c = fighter([granted('dm', 'Indomitable (two uses)', 2)]);
    expect(useFeature(c, 'Indomitable (one use)').events[0].message).toBe('Used Indomitable (two uses) (1/2 left; recharges on a Long Rest)');
    expect(restoreFeature(useFeature(c, 'Indomitable (one use)').character, 'Indomitable (three uses)').events[0].message).toBe('Indomitable (two uses): regained 1 use (2/2)');
    // The table's next name rewrites it, under that name.
    const r = addFeature(c, tableRow('Indomitable (three uses)', 3));
    expect(r.character.features.map((f) => [f.id, f.name, f.uses?.max])).toEqual([['dm', 'Indomitable (three uses)', 3]]);
  });

  it("an older 2024 book Fighter's bare Indomitable without uses beside the DM's \"Indomitable (one use)\": the table's next name rewrites the DM's entry, and the class's is left to the table's re-read (srd:class:fighter, \"Indomitable (two uses)\" at 13)", () => {
    // The class's entry from before the app read the table's counts (no uses); the DM's from a features_add at 9.
    const bare: Feature = { id: 'ind', name: 'Indomitable', source: 'class', sourceName: 'Fighter 9', description: 'The book text.' };
    const dm = indomitable('dm', 'Indomitable (one use)', 1, 1, { sourceName: 'Granted in play' });
    const c = mira({ classes: [bookFighter(13)], spellcasting: undefined, features: [bare, dm] });
    const r = addFeature(c, { ...tableRow('Indomitable (two uses)', 2), description: 'The DM words.' });
    expect(r.events[0].message).toBe('Updated feature: Indomitable (one use) → Indomitable (two uses)');
    expect(r.character.features).toEqual([bare, { ...dm, name: 'Indomitable (two uses)', description: 'The DM words.', uses: { max: 2, used: 1, recharge: 'long' } }]);
    // An older-edition book's Fighter doesn't stand in for the SRD's: its table's counts aren't the app's to read, so the
    // name is added beside as for any family no one counts.
    const older = { ...c, classes: [bookFighter(13, '2014')] };
    expect(addFeature(older, tableRow('Indomitable (two uses)', 2)).character.features.map((f) => f.name)).toEqual(['Indomitable', 'Indomitable (one use)', 'Indomitable (two uses)']);
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

describe('changeAbilityScore (SRD 5.2.1 Ability Score Improvement; Gaining a Level for Constitution changes, srd:rule:level-advancement-gaining-a-level)', () => {
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

  it("keeps an AC set by hand (an effect the app doesn't count) and warns with the computed value", () => {
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

  it('keeps the Concentration when asked: a scroll removed as it is read, its spell going on (N3; srd:magic-item:spell-scroll: "Once the spell is cast, the scroll crumbles to dust"; srd:rule:concentration)', () => {
    const scroll = addSpell(mira(), { name: 'Hold Person', level: 2, prepared: true, source: 'Spell Scroll' }).character;
    const reading = setConcentration(scroll, 'Hold Person').character;
    const kept = removeSpell(reading, 'Hold Person', { keepConcentration: true });
    expect(kept.character.spellcasting?.concentratingOn).toBe('Hold Person');
    expect(kept.character.spellcasting?.spells.some((s) => s.name === 'Hold Person')).toBe(false);
    expect(kept.events.map((e) => e.message)).toEqual(['Removed spell: Hold Person']);
    // Without the option, removing it ends it, as before.
    expect(removeSpell(reading, 'Hold Person').events.map((e) => e.message)).toEqual(['Removed spell: Hold Person', 'Concentration on Hold Person ends.']);
  });

  it('removes a spell by its id: the exact entry, never one a name would match', () => {
    // Shield and a "Shield of Faith" side by side: removeSpell's name match could take either.
    const both = addSpell(mira(), { name: 'Shield of Faith', level: 1, prepared: true }).character;
    const shield = both.spellcasting?.spells.find((s) => s.name === 'Shield');
    const removed = removeSpellById(both, shield?.id ?? '');
    expect(removed.character.spellcasting?.spells.map((s) => s.name)).toContain('Shield of Faith');
    expect(removed.character.spellcasting?.spells.map((s) => s.name)).not.toContain('Shield');
    expect(removed.events.map((e) => e.message)).toEqual(['Removed spell: Shield']);
    // It ends Concentration on the spell, as removeSpell does.
    const focused = setConcentration(mira(), 'Detect Magic').character;
    const detect = focused.spellcasting?.spells.find((s) => s.name === 'Detect Magic');
    expect(removeSpellById(focused, detect?.id ?? '').character.spellcasting?.concentratingOn).toBeNull();
    const gone = removeSpellById(mira(), 'no-such-id');
    expect(gone.character).toEqual(mira());
    expect(gone.events.map((e) => e.message)).toEqual(['That spell is no longer on the sheet.']);
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
          'Life Drain −5 (until ended) goes by that name: give the drain a name of its own (as in "Life Drain (Wight)"), or end that one in an earlier call (hp applies before hp_max_end). This hit wasn\'t applied (neither its damage nor its drain).',
      },
    ]);
    const full = hardy();
    const blank = applyDrainingDamage(full, 10, { damageType: 'necrotic', drain: ' \n\t ' });
    expect(blank.character).toBe(full);
    expect(blank.events).toEqual([
      { type: 'warning', message: 'A drain needs a name (the effect, as in "Life Drain"). This hit wasn\'t applied (neither its damage nor its drain).' },
    ]);
    expect(drainProblem(cursed, 'Life Drain (Wraith)')).toBeNull();
    // Nor under an effect's raise (srd:spell:aid). The hit applies before hp_max_end, so the end must come in an earlier call.
    expect(drainProblem(aided, 'Aid')).toBe(
      'Aid +5 (until a Long Rest) goes by that name: give the drain a name of its own (as in "Life Drain (Wight)"), or end that one in an earlier call (hp applies before hp_max_end).',
    );
    // The example is never a name an entry holds: not the one refused (a Wight's drain a Death Dog's poison keeps,
    // srd:monster:death-dog), nor another's.
    const poisoned = adjustHpMax(hardy(), { name: 'Life Drain (Wight)', change: -5, ends: 'when-ended' }).character;
    const kept = 'give the drain a name of its own, or end that one in an earlier call (hp applies before hp_max_end).';
    expect(drainProblem(poisoned, 'Life Drain (Wight)')).toBe(`Life Drain (Wight) −5 (until ended) goes by that name: ${kept}`);
    const both = adjustHpMax(poisoned, { name: 'Life Drain', change: -3, ends: 'when-ended' }).character;
    expect(drainProblem(both, 'Life Drain')).toBe(`Life Drain −3 (until ended) goes by that name: ${kept}`);
    const twin = adjustHpMax(hardy(), { name: 'Life Drain Wight', change: -5, ends: 'when-ended' }).character; // the same name
    expect(drainProblem(twin, 'Life Drain Wight')).toBe(`Life Drain Wight −5 (until ended) goes by that name: ${kept}`);
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

describe('AC from spells (srd:spell:mage-armor; srd:spell:shield-of-faith)', () => {
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor', equipped: true };
  /** Mira in Chain Mail she is trained for: AC 16, worked out from it. */
  const armored = (patch: Partial<Character> = {}) =>
    mira({ armorTraining: ['Heavy armor'], inventory: [...mira().inventory, mail], armorClass: 16, acFormula: 'Chain Mail 16', ...patch });

  it('records Mage Armor: base AC 13 + Dexterity ("Mage Armor: AC 12 → 15"), and ends it ("Mage Armor ends: AC 15 → 12")', () => {
    const r = addAcSpell(mira(), 'mage armor');
    expect(r.character).toMatchObject({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2', acSpells: ['Mage Armor'] });
    expect(r.events).toEqual([{ type: 'combat', message: 'Mage Armor: AC 12 → 15' }]);
    expect(r.character.updatedAt).toBeGreaterThan(mira().updatedAt);
    const ended = endAcSpell(r.character, 'Mage Armor');
    expect(ended.character).toMatchObject({ armorClass: 12, acFormula: '10 + DEX 2' });
    expect(ended.character).not.toHaveProperty('acSpells');
    expect(ended.events).toEqual([{ type: 'combat', message: 'Mage Armor ends: AC 15 → 12' }]);
  });

  it('records Shield of Faith on top: +2 (srd:spell:shield-of-faith: "a +2 bonus to AC for the duration")', () => {
    const both = addAcSpell(addAcSpell(mira(), 'Mage Armor').character, 'Shield of Faith');
    expect(both.character).toMatchObject({ armorClass: 17, acFormula: 'Mage Armor: 13 + DEX 2 + Shield of Faith 2', acSpells: ['Mage Armor', 'Shield of Faith'] });
    expect(messages(both)).toEqual(['Shield of Faith: AC 15 → 17']);
    expect(countedAcSpells(both.character)).toEqual(['Mage Armor', 'Shield of Faith']);
    expect(messages(addAcSpell(armored(), 'Shield of Faith'))).toEqual(['Shield of Faith: AC 16 → 18']);
  });

  it('changes nothing, with a warning, for a spell the app doesn\'t count, one already recorded, or one not recorded', () => {
    const c = mira();
    for (const [name, warning] of [
      ['Shield', 'The app counts AC only for Mage Armor and Shield of Faith, not Shield.'],
      ['  Barkskin ', 'The app counts AC only for Mage Armor and Shield of Faith, not Barkskin.'],
      ['', 'The app counts AC only for Mage Armor and Shield of Faith.'],
    ] as const) {
      expect(addAcSpell(c, name)).toEqual({ character: c, events: [{ type: 'warning', message: warning }] });
      expect(endAcSpell(c, name)).toEqual({ character: c, events: [{ type: 'warning', message: warning }] });
    }
    const recorded = addAcSpell(c, 'Mage Armor').character;
    expect(addAcSpell(recorded, 'Mage Armor')).toEqual({ character: recorded, events: [{ type: 'warning', message: 'Mage Armor is already recorded.' }] });
    expect(endAcSpell(c, 'Shield of Faith')).toEqual({ character: c, events: [{ type: 'warning', message: "Shield of Faith isn't recorded." }] });
  });

  it('Mage Armor needs a target who isn\'t wearing armor (srd:spell:mage-armor: "You touch a willing creature who isn\'t wearing armor")', () => {
    const c = armored();
    expect(addAcSpell(c, 'Mage Armor')).toEqual({ character: c, events: [{ type: 'warning', message: "Mage Armor needs a target who isn't wearing armor: Mira Voss wears Chain Mail." }] });
    const unknown = armored({ inventory: [{ ...mail, name: 'Elven Chain' }] });
    expect(messages(addAcSpell(unknown, 'Mage Armor'))).toEqual(["Mage Armor needs a target who isn't wearing armor: Mira Voss wears Elven Chain."]);
    // A Shield isn't armor for it.
    const shield: InventoryItem = { id: 'sh', name: 'Shield', quantity: 1, category: 'shield', equipped: true };
    expect(addAcSpell(mira({ armorTraining: ['Shields'], inventory: [shield], armorClass: 14, acFormula: '10 + DEX 2 + Shield 2' }), 'Mage Armor').character).toMatchObject({
      armorClass: 17,
      acFormula: 'Mage Armor: 13 + DEX 2 + Shield 2',
    });
  });

  it('a Mage Armor lower than Unarmored Defense is recorded and not counted (srd:rule:armor-class: "you can\'t use more than one")', () => {
    const barbarian = mira({
      abilityScores: { str: 16, dex: 14, con: 18, int: 8, wis: 10, cha: 10 },
      classes: [{ classId: 'srd:class:barbarian', name: 'Barbarian', level: 1, hitDie: 12, casterType: 'none' }],
      armorClass: 16,
      acFormula: 'Unarmored Defense: 10 + DEX 2 + CON 4',
    });
    const r = addAcSpell(barbarian, 'Mage Armor');
    expect(r.character).toMatchObject({ armorClass: 16, acSpells: ['Mage Armor'] });
    expect(messages(r)).toEqual(['Mage Armor: AC stays 16']);
    expect(countedAcSpells(r.character)).toEqual([]);
  });

  it("equipping armor doesn't end Mage Armor: it stops counting, and counts again when the armor comes off (srd:rule:armor: each category takes time to don or doff)", () => {
    const robed = addAcSpell(mira({ armorTraining: ['Heavy armor'], inventory: [...mira().inventory, { ...mail, equipped: false }] }), 'Mage Armor').character;
    expect(robed.armorClass).toBe(15);
    const donned = updateItem(robed, 'Chain Mail', { equipped: true });
    expect(donned.character).toMatchObject({ armorClass: 16, acFormula: 'Chain Mail 16', acSpells: ['Mage Armor'] });
    expect(messages(donned)).toEqual(['Updated Chain Mail: equipped', 'AC 15 → 16 (Chain Mail 16)']);
    const doffed = updateItem(donned.character, 'Chain Mail', { equipped: false });
    expect(doffed.character).toMatchObject({ armorClass: 15, acFormula: 'Mage Armor: 13 + DEX 2', acSpells: ['Mage Armor'] });
  });
});

describe("what ends with the hero's Concentration (srd:rule:concentration: \"If the effect's creator loses Concentration, the effect ends\")", () => {
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor', equipped: true };
  const armored = (patch: Partial<Character> = {}) =>
    mira({ armorTraining: ['Heavy armor'], inventory: [...mira().inventory, mail], armorClass: 16, acFormula: 'Chain Mail 16', ...patch });
  /** Concentrating on Shield of Faith she cast on herself, recorded: AC 18 on Chain Mail 16. */
  const faithful = (patch: Partial<Character> = {}) => addAcSpell(setConcentration(armored(patch), 'Shield of Faith').character, 'Shield of Faith').character;
  const faithEnds = 'Shield of Faith ends: AC 18 → 16';
  const after = (c: Character) => {
    expect(c.armorClass).toBe(16);
    expect(c.acFormula).toBe('Chain Mail 16');
    expect(c).not.toHaveProperty('acSpells');
    expect(c.spellcasting?.concentratingOn).toBeNull();
  };

  it('every path that ends it ends the Shield of Faith record and takes its +2 off', () => {
    expect(faithful()).toMatchObject({ armorClass: 18, acSpells: ['Shield of Faith'] });
    // 0 HP (srd:rule:damage-and-healing-dropping-to-0-hit-points-falling-unconscious: "you have the Unconscious
    // condition"; srd:condition:incapacitated: "Your Concentration is broken").
    const down = applyDamage(faithful(), 12);
    after(down.character);
    expect(messages(down).slice(1)).toEqual(['Concentration on Shield of Faith ends (Unconscious).', faithEnds]);
    // An Incapacitating condition (srd:condition:incapacitated: "Your Concentration is broken").
    for (const id of ['paralyzed', 'unconscious', 'stunned']) {
      const r = addCondition(faithful(), { id });
      after(r.character);
      expect(messages(r).slice(1), id).toEqual([`Concentration on Shield of Faith ends (${id[0].toUpperCase()}${id.slice(1)}).`, faithEnds]);
    }
    // Death (srd:rule:concentration: "Your Concentration ends if you … die"): massive damage
    // (srd:rule:damage-and-healing-dropping-to-0-hit-points-instant-death, Massive Damage).
    const dead = applyDamage(faithful(), 29);
    expect(dead.character.deathSaves.dead).toBe(true);
    after(dead.character);
    expect(messages(dead).slice(1)).toEqual(['Concentration on Shield of Faith ends (death).', faithEnds]);
    // The DM or the player ends it.
    const off = setConcentration(faithful(), null);
    after(off.character);
    expect(messages(off)).toEqual(['No longer concentrating on Shield of Faith.', faithEnds]);
    // Another spell (srd:rule:concentration, Another Concentration Effect).
    const bless = setConcentration(faithful(), 'Bless');
    expect(bless.character).toMatchObject({ armorClass: 16, spellcasting: { concentratingOn: 'Bless' } });
    expect(bless.character).not.toHaveProperty('acSpells');
    expect(messages(bless)).toEqual(['Concentration on Shield of Faith ends (started concentrating on Bless).', faithEnds, 'Concentrating on Bless.']);
    // The spell leaves the sheet, by name or by id.
    const known = (c: Character) => addSpell(c, { name: 'Shield of Faith', level: 1, prepared: true, concentration: true }).character;
    const removed = removeSpell(known(faithful()), 'Shield of Faith');
    after(removed.character);
    expect(messages(removed)).toEqual(['Removed spell: Shield of Faith', 'Concentration on Shield of Faith ends.', faithEnds]);
    const withSpell = known(faithful());
    const byId = removeSpellById(withSpell, withSpell.spellcasting?.spells.find((s) => s.name === 'Shield of Faith')?.id ?? '');
    after(byId.character);
    // Its time runs out (expireConcentration).
    const expired = expireConcentration(faithful(), 'shield of faith', 'its duration is up');
    after(expired.character);
    expect(messages(expired)).toEqual(['Concentration on Shield of Faith ends: its duration is up.', faithEnds]);
    // A Long Rest (srd:rule:long-rest: "During sleep, you have the Unconscious condition").
    const rested = applyLongRest(faithful());
    after(rested.character);
    expect(messages(rested)[0]).toBe(faithEnds);
  });

  it("another caster's Shield of Faith on the hero isn't hers to end: her own Concentration ending leaves it", () => {
    const blessed = addAcSpell(setConcentration(armored(), 'Bless').character, 'Shield of Faith').character;
    const r = setConcentration(blessed, null);
    expect(r.character).toMatchObject({ armorClass: 18, acSpells: ['Shield of Faith'] });
    expect(messages(r)).toEqual(['No longer concentrating on Bless.']);
  });

  it('expireConcentration ends only the spell the sheet still holds', () => {
    const blessed = setConcentration(mira(), 'Bless').character;
    expect(expireConcentration(blessed, 'Bless', 'it runs out after the fight.').events).toEqual([
      { type: 'condition-removed', message: 'Concentration on Bless ends: it runs out after the fight.' },
    ]);
    // The sheet moved on, or nothing to end: unchanged (a repeated call is harmless).
    expect(expireConcentration(blessed, 'Haste', 'its duration is up')).toEqual({ character: blessed, events: [] });
    expect(expireConcentration(mira(), 'Bless', 'its duration is up')).toEqual({ character: mira(), events: [] });
  });

  it('an AC set by hand for the spell gets a reminder, whatever the spell (srd:spell:haste: "+2 bonus to Armor Class")', () => {
    // AC 18 "set by the DM: Haste" on Chain Mail 16: the app can't take Haste out of a hand-set AC itself.
    const hasted = () => setConcentration(armored({ armorClass: 18, acFormula: 'set by the DM: Haste' }), 'Haste').character;
    const reminder = { type: 'warning', message: 'AC 18 was set by hand for Haste: if it counted Haste, set the AC back to 16 (armor and abilities).' };
    const off = setConcentration(hasted(), null);
    expect(off.character.armorClass).toBe(18);
    expect(off.events).toEqual([{ type: 'condition-removed', message: 'No longer concentrating on Haste.' }, reminder]);
    expect(addCondition(hasted(), { id: 'stunned' }).events.at(-1)).toEqual(reminder);
    expect(applyDamage(hasted(), 12).events.at(-1)).toEqual(reminder);
    expect(setConcentration(hasted(), 'Bless').events).toContainEqual(reminder);
    expect(expireConcentration(hasted(), 'Haste', 'its duration is up').events.at(-1)).toEqual(reminder);
    // An old save's Shield of Faith set by hand, with no record: the same reminder.
    const old = setConcentration(armored({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }), 'Shield of Faith').character;
    expect(messages(setConcentration(old, null))).toEqual([
      'No longer concentrating on Shield of Faith.',
      'AC 18 was set by hand for Shield of Faith: if it counted Shield of Faith, set the AC back to 16 (armor and abilities).',
    ]);
    // Nothing when the hand-set formula names another spell, or the AC is worked out.
    expect(messages(setConcentration(setConcentration(armored({ armorClass: 18, acFormula: 'set by the DM: Haste' }), 'Bless').character, null))).toEqual([
      'No longer concentrating on Bless.',
    ]);
    // A record and a hand-set AC: the record's +2 comes off the hand-set AC and its formula; no reminder is left to give.
    const both = faithful({ armorClass: 18, acFormula: 'set by the DM: Haste' });
    expect(both).toMatchObject({ armorClass: 20, acFormula: 'set by the DM: Haste + Shield of Faith 2' });
    const ended = setConcentration(both, null);
    expect(ended.character).toMatchObject({ armorClass: 18, acFormula: 'set by the DM: Haste' });
    expect(messages(ended)).toEqual(['No longer concentrating on Shield of Faith.', 'Shield of Faith ends: AC 20 → 18']);
  });
});

describe('the AC rule under an AC set by hand, and what ends with the hero\'s Concentration (spell effects review)', () => {
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor', equipped: true };
  /** In Chain Mail she is trained for: AC 16 worked out from it, unless `patch` says otherwise. */
  const armored = (patch: Partial<Character> = {}) =>
    mira({ armorTraining: ['Heavy armor'], inventory: [...mira().inventory, mail], armorClass: 16, acFormula: 'Chain Mail 16', ...patch });
  /** A cleric's spells: no Shield, and Shield of Faith on the sheet (id "sof"). */
  const clericSpells = (c: Character): Character => ({
    ...c,
    spellcasting: {
      ...c.spellcasting!,
      spells: [...c.spellcasting!.spells.filter((s) => s.name !== 'Shield'), { id: 'sof', name: 'Shield of Faith', level: 1, prepared: true, concentration: true }],
    },
  });
  /** Concentrating on her own Shield of Faith, recorded. */
  const faithful = (c: Character) => addAcSpell(setConcentration(c, 'Shield of Faith').character, 'Shield of Faith').character;

  it('a Shield of Faith ending under a hand-set Slow takes its 2 off on every path, never turning the AC into Chain Mail 16 (E1; srd:spell:slow: "it takes a -2 penalty to AC"; srd:spell:shield-of-faith: "+2 bonus to AC")', () => {
    // Slow first (the DM sets 14), then Shield of Faith; or Shield of Faith first (18), then the DM's 16 for Slow, which
    // keeps the counted part (update_character armor_class). Either way 16 = Chain Mail's, by coincidence.
    const slowFirst = () => faithful(armored({ armorClass: 14, acFormula: 'set by the DM: Slow from the Stone Golem' }));
    const faithFirst = () => ({ ...faithful(armored()), armorClass: 16, acFormula: 'set by the DM: Slow from the Stone Golem + Shield of Faith 2' });
    expect(slowFirst()).toMatchObject({ armorClass: 16, acFormula: 'set by the DM: Slow from the Stone Golem + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    for (const start of [slowFirst, faithFirst]) {
      const paths = {
        endAcSpell: endAcSpell(start(), 'Shield of Faith'),
        'concentration null': setConcentration(start(), null),
        '0 HP': applyDamage(start(), 12),
        expire: expireConcentration(start(), 'Shield of Faith', 'its duration is up'),
        'Long Rest': applyLongRest(start()),
      };
      for (const [path, r] of Object.entries(paths)) {
        expect(r.character, path).toMatchObject({ armorClass: 14, acFormula: 'set by the DM: Slow from the Stone Golem' });
        expect(r.character, path).not.toHaveProperty('acSpells');
        expect(messages(r), path).toContain('Shield of Faith ends: AC 16 → 14');
        expect(messages(r).filter((m) => m.includes('set by hand')), path).toEqual([]);
      }
    }
  });

  it("the record's end gives no hand-set reminder for Shield of Faith: the app took its 2 off once (srd:rule:concentration: \"If the effect's creator loses Concentration, the effect ends\")", () => {
    // An old save's "set by the DM: Shield of Faith and Haste" 20 on Chain Mail 16, recorded: kept at 20, counted.
    const old = faithful(armored({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' }));
    expect(old).toMatchObject({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith 2' });
    const ended = setConcentration(old, null);
    // The DM's words stay, marked as no longer counting it (E1).
    expect(ended.character).toMatchObject({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith and Haste + Shield of Faith ended' });
    expect(messages(ended)).toEqual(['No longer concentrating on Shield of Faith.', 'Shield of Faith ends: AC 20 → 18']);
    expect(messages(applyDamage(old, 12)).slice(1)).toEqual(['Concentration on Shield of Faith ends (Unconscious).', 'Shield of Faith ends: AC 20 → 18']);
    // With no record, the old save's words still get the reminder (the app can't take the spell out itself).
    const unrecorded = setConcentration(armored({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' }), 'Shield of Faith').character;
    expect(messages(setConcentration(unrecorded, null))).toEqual([
      'No longer concentrating on Shield of Faith.',
      'AC 20 was set by hand for Shield of Faith: if it counted Shield of Faith, set the AC back to 16 (armor and abilities).',
    ]);
  });

  it("endAcSpell on a spell that isn't recorded reminds the DM of an AC set by hand for it (H2; srd:spell:shield-of-faith; srd:spell:mage-armor)", () => {
    const old = armored({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith' });
    expect(endAcSpell(old, 'shield of faith')).toEqual({
      character: old,
      events: [
        { type: 'warning', message: "Shield of Faith isn't recorded." },
        { type: 'warning', message: 'AC 18 was set by hand for Shield of Faith: if it counted Shield of Faith, set the AC back to 16 (armor and abilities).' },
      ],
    });
    const robe = mira({ armorClass: 15, acFormula: 'set by the DM: Mage Armor' });
    expect(messages(endAcSpell(robe, 'Mage Armor'))).toEqual([
      "Mage Armor isn't recorded.",
      'AC 15 was set by hand for Mage Armor: if it counted Mage Armor, set the AC back to 12 (armor and abilities).',
    ]);
    // Nothing to remind: a worked-out AC, or a hand-set one naming something else.
    expect(messages(endAcSpell(armored({ armorClass: 18, acFormula: 'set by the DM: Haste' }), 'Shield of Faith'))).toEqual(["Shield of Faith isn't recorded."]);
  });

  it('a looser name for the spell already held is the same spell: nothing ends (H9; srd:rule:concentration)', () => {
    const held = faithful(clericSpells(armored()));
    expect(held).toMatchObject({ armorClass: 18, acSpells: ['Shield of Faith'], spellcasting: { concentratingOn: 'Shield of Faith' } });
    for (const name of ['Shield', 'Faith', 'shield of faith', ' Shield-of-Faith ']) expect(setConcentration(held, name), name).toEqual({ character: held, events: [] });
    // A name the sheet finds as another spell is another Concentration (Mira knows Shield).
    const wizard = faithful(armored());
    const shield = setConcentration(wizard, 'Shield');
    expect(shield.character).toMatchObject({ armorClass: 16, spellcasting: { concentratingOn: 'Shield' } });
    expect(messages(shield)).toEqual(['Concentration on Shield of Faith ends (started concentrating on Shield).', 'Shield of Faith ends: AC 18 → 16', 'Concentrating on Shield.']);
    // A spell not on the sheet, restated as it was given: the same.
    const blessed = setConcentration(mira(), 'Bless').character;
    expect(setConcentration(blessed, 'bless')).toEqual({ character: blessed, events: [] });
  });

  it('removeSpellById keepConcentration: a spell swapped out of the prepared list goes on, with its Shield of Faith +2 (S2; srd:rule:concentration: "The following factors break Concentration" lists Another Concentration Effect, Damage, Incapacitated or Dead)', () => {
    const held = faithful(clericSpells(armored()));
    const kept = removeSpellById(held, 'sof', { keepConcentration: true });
    expect(kept.events).toEqual([{ type: 'feature-used', message: 'Removed spell: Shield of Faith' }]);
    expect(kept.character).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield of Faith 2', acSpells: ['Shield of Faith'], spellcasting: { concentratingOn: 'Shield of Faith' } });
    expect(kept.character.spellcasting?.spells.some((s) => s.id === 'sof')).toBe(false);
    // Without it, removing the spell still ends its Concentration (and the +2).
    const ended = removeSpellById(held, 'sof');
    expect(messages(ended)).toEqual(['Removed spell: Shield of Faith', 'Concentration on Shield of Faith ends.', 'Shield of Faith ends: AC 18 → 16']);
    expect(ended.character.spellcasting?.concentratingOn).toBeNull();
    expect(removeSpellById(held, 'sof', { keepConcentration: false }).events).toEqual(ended.events);
  });

  it("armor the app can't identify keeps a counted Shield of Faith in its formula, so the DM's AC for it and the spell's end agree (E4/S1; srd:spell:shield-of-faith; srd:magic-item:elven-chain: \"You gain a +1 bonus to Armor Class while you wear this armor\")", () => {
    const elven: InventoryItem = { id: 'ec', name: 'Elven Chain', quantity: 1, category: 'armor', magic: true, equipped: false };
    const start = addAcSpell(armored({ inventory: [...mira().inventory, mail, elven] }), 'Shield of Faith').character;
    expect(start).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield of Faith 2' });
    const on = updateItem(start, 'Elven Chain', { equipped: true }).character;
    const swapped = updateItem(on, 'Chain Mail', { equipped: false });
    // The armor's part keeps the AC less the counted +2 (E3): 16 + 2 reads as the 18 stored.
    expect(swapped.character).toMatchObject({ armorClass: 18, acFormula: 'Elven Chain (stats unknown — AC kept at 16) + Shield of Faith 2' });
    expect(countedAcSpells(swapped.character)).toEqual(['Shield of Faith']);
    expect(characterStatusLine(swapped.character)).toContain(' · AC 18 (Shield of Faith) · ');
    expect(messages(swapped)).toContain("AC kept at 18: Elven Chain's armor stats are unknown, so set the AC by hand.");
    // The DM sets 19 for it (Chain Mail 16 + 1, and the +2 still counted: the hand-set formula keeps the part).
    const set = { ...swapped.character, armorClass: 19, acFormula: 'set by the DM: Elven Chain + Shield of Faith 2' };
    const ended = endAcSpell(set, 'Shield of Faith');
    expect(ended.character).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Elven Chain' });
    expect(messages(ended)).toEqual(['Shield of Faith ends: AC 19 → 17']);
  });

  it("armor put on over a hand-set AC keeping Mage Armor's part drops it: the status line no longer counts Mage Armor (E5/H7/S7; srd:spell:mage-armor: \"a willing creature who isn't wearing armor\")", () => {
    const leather: InventoryItem = { id: 'la', name: 'Leather Armor', quantity: 1, category: 'armor', equipped: false };
    const robed = addAcSpell(mira({ armorTraining: ['Light armor'], inventory: [...mira().inventory, leather] }), 'Mage Armor').character;
    // The DM sets 17 for Haste (srd:spell:haste: "+2 bonus to Armor Class"): the hand-set formula keeps the counted part.
    const hasted = { ...robed, armorClass: 17, acFormula: 'set by the DM: Haste + Mage Armor: 13' };
    expect(characterStatusLine(hasted)).toContain(' · AC 17 (Mage Armor) · ');
    const donned = updateItem(hasted, 'Leather Armor', { equipped: true });
    expect(donned.character).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Haste', acSpells: ['Mage Armor'] });
    expect(countedAcSpells(donned.character)).toEqual([]);
    expect(characterStatusLine(donned.character)).toContain(' · AC 17 · ');
    expect(characterStatusLine(donned.character)).not.toContain('Mage Armor');
    expect(messages(donned)).toContain(
      "AC kept at 17: it differs from the 15 that gear and features gave, so it may include an effect the app doesn't count or a manual change. Gear and features now give AC 13 (Leather Armor 11 + DEX 2); update the AC if that is right.",
    );
    // Ending Mage Armor then moves nothing and leaves no part behind.
    const ended = endAcSpell(donned.character, 'Mage Armor');
    expect(ended.character).toMatchObject({ armorClass: 17, acFormula: 'set by the DM: Haste' });
    expect(messages(ended)).toEqual(['Mage Armor ends: AC stays 17']);
  });
});

describe('Shield of Faith cast again, the AC the gear gives, and the name recorded (spell effects re-check)', () => {
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const handSet = (r: { events: { message: string }[] }) => messages(r).filter((m) => m.includes('set by hand'));
  const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor', equipped: true };
  /** Mira in Chain Mail, trained for it: AC 16 worked out from it, unless `patch` says otherwise. */
  const armored = (patch: Partial<Character> = {}) =>
    mira({ armorTraining: ['Heavy armor'], inventory: [...mira().inventory, mail], armorClass: 16, acFormula: 'Chain Mail 16', ...patch });
  /** Mira's own casting of Shield of Faith: its Concentration (update_character concentration), then its record (ac_spells_add). */
  const cast = (c: Character) => {
    const on = setConcentration(c, 'Shield of Faith');
    const recorded = addAcSpell(on.character, 'Shield of Faith');
    return { character: recorded.character, events: [...on.events, ...recorded.events] };
  };
  /** Mira's Concentration on it ends (update_character concentration: null; the record ends with it). */
  const lose = (c: Character) => setConcentration(c, null);

  it("cast again once the app has taken it off an AC set by hand naming it, it adds its 2 again, and each end takes 2 off with no reminder to take it off again (E1; srd:spell:shield-of-faith: \"a +2 bonus to AC for the duration\"; srd:rule:casting-spells-effects-combining-spell-effects: \"while their durations overlap\")", () => {
    const ring: InventoryItem = { id: 'rp', name: 'Ring of Protection', quantity: 1, category: 'magic-item', attuned: true };
    // FIXES' kept examples (old saves): [what, the hero, AC with the spell, AC without it].
    const examples: Array<[string, Character, number, number]> = [
      ['Shield of Faith and Haste (srd:spell:haste)', armored({ armorClass: 20, acFormula: 'set by the DM: Shield of Faith and Haste' }), 20, 18],
      ['a Ring of Protection attuned since (srd:magic-item:ring-of-protection)', armored({ inventory: [...mira().inventory, mail, ring], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }), 18, 16],
      ["the wizard's 17", mira({ armorClass: 17, acFormula: 'set by the DM: Shield of Faith from Brother Aldo' }), 17, 15],
    ];
    for (const [what, start, up, down] of examples) {
      const first = cast(start);
      expect(first.character.armorClass, what).toBe(up);
      const lost = lose(first.character);
      const again = cast(lost.character);
      const lostAgain = lose(again.character);
      expect([lost, again, lostAgain].map((r) => r.character.armorClass), what).toEqual([down, up, down]);
      expect(messages(again), what).toContain(`Shield of Faith: AC ${down} → ${up}`);
      expect(messages(lostAgain), what).toEqual(['No longer concentrating on Shield of Faith.', `Shield of Faith ends: AC ${up} → ${down}`]);
      expect([lost, again, lostAgain].flatMap(handSet), what).toEqual([]);
      // A Long Rest ends a casting the same way (srd:rule:long-rest: "During sleep, you have the Unconscious condition").
      const rested = applyLongRest(cast(lostAgain.character).character);
      expect(rested.character.armorClass, what).toBe(down);
      expect(handSet(rested), what).toEqual([]);
      // Then a casting that isn't recorded, ended, endAcSpell and a Long Rest give no reminder: the 2 is off already.
      const unrecorded = setConcentration(rested.character, 'Shield of Faith').character;
      expect(messages(setConcentration(unrecorded, null)), what).toEqual(['No longer concentrating on Shield of Faith.']);
      expect(messages(endAcSpell(rested.character, 'Shield of Faith')), what).toEqual(["Shield of Faith isn't recorded."]);
      expect(handSet(applyLongRest(unrecorded)), what).toEqual([]);
    }
    // A new save's reason naming the spell while it is counted (srd:spell:slow: "it takes a -2 penalty to AC").
    for (const [acFormula, up, down] of [
      ['set by the DM: Slow from the Stone Golem (-2); Shield of Faith still up + Shield of Faith 2', 16, 14],
      ['set by the DM: Haste from Lyra, on top of Shield of Faith + Shield of Faith 2', 20, 18],
    ] as const) {
      const start = setConcentration(armored({ armorClass: up, acFormula, acSpells: ['Shield of Faith'] }), 'Shield of Faith').character;
      const lost = lose(start);
      const again = cast(lost.character);
      const lostAgain = lose(again.character);
      expect([lost, again, lostAgain].map((r) => r.character.armorClass), acFormula).toEqual([down, up, down]);
      expect(lostAgain.character.acFormula).toBe(acFormula.replace(' + Shield of Faith 2', ' + Shield of Faith ended'));
      expect([lost, again, lostAgain].flatMap(handSet), acFormula).toEqual([]);
      expect(applyLongRest(again.character).character.armorClass, acFormula).toBe(down);
    }
  });

  it('the D1 state: a hand-set AC the gear alone now gives is taken to hold no Shield of Faith, so recording it adds the 2, with F3\'s warning, and its end takes them off (E2/F3; srd:spell:shield-of-faith: "a +2 bonus to AC"; srd:rule:armor-class)', () => {
    // An older save's 18 "set by the DM: Shield of Faith" in Chain Mail, concentrating on the spell; then a Shield.
    const shield: InventoryItem = { id: 'sh', name: 'Shield', quantity: 1, category: 'shield', equipped: false };
    const old = setConcentration(
      armored({ armorTraining: ['Heavy armor', 'Shields'], inventory: [...mira().inventory, mail, shield], armorClass: 18, acFormula: 'set by the DM: Shield of Faith' }),
      'Shield of Faith',
    ).character;
    const donned = updateItem(old, 'Shield', { equipped: true });
    expect(donned.character).toMatchObject({ armorClass: 18, acFormula: 'set by the DM: Shield of Faith' });
    expect(messages(donned)).toEqual(['Updated Shield: equipped']);
    // Recorded: 20 (Chain Mail 16 + Shield 2 + Shield of Faith 2), and its end 18. The words name the spell, so the DM
    // is told how to put 18 back if it already counted the spell beside a penalty (F3).
    const recorded = addAcSpell(donned.character, 'Shield of Faith');
    expect(recorded.character).toMatchObject({ armorClass: 20, acFormula: 'Chain Mail 16 + Shield 2 + Shield of Faith 2', acSpells: ['Shield of Faith'] });
    expect(messages(recorded)).toEqual([
      'Shield of Faith: AC 18 → 20',
      "AC 18, set by hand, names Shield of Faith, but gear and features alone give 18, so the app now counts Shield of Faith as well (AC 20): if 18 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 18.",
    ]);
    const ended = lose(recorded.character);
    expect(ended.character).toMatchObject({ armorClass: 18, acFormula: 'Chain Mail 16 + Shield 2' });
    expect(messages(ended)).toEqual(['No longer concentrating on Shield of Faith.', 'Shield of Faith ends: AC 20 → 18']);
    // Below the gear (srd:spell:slow: "a -2 penalty to AC"): "Slow, without Shield of Faith" 14 gives 16, not "AC stays 14".
    const slowed = addAcSpell(armored({ armorClass: 14, acFormula: 'set by the DM: Slow, without Shield of Faith' }), 'Shield of Faith');
    expect(slowed.character).toMatchObject({ armorClass: 16, acFormula: 'set by the DM: Slow, without Shield of Faith + Shield of Faith 2' });
    expect(messages(slowed)).toEqual([
      'Shield of Faith: AC 14 → 16',
      "AC 14, set by hand, names Shield of Faith, but gear and features alone give 16, so the app now counts Shield of Faith as well (AC 16): if 14 already counted it beside a penalty the app doesn't count (such as Slow), set the AC to 14.",
    ]);
  });

  it('records a new Concentration in the sheet\'s spelling only of that very name, else as given (E5; srd:spell:invisibility: "Concentration, up to 1 hour"; srd:spell:see-invisibility: "Duration: 1 hour")', () => {
    const knowing = (...names: string[]) =>
      mira({ spellcasting: { ...mira().spellcasting!, spells: [...mira().spellcasting!.spells, ...names.map((name, i) => ({ id: `k${i}`, name, level: 2, prepared: true }))] } });
    const on = (r: { character: Character }) => r.character.spellcasting?.concentratingOn;
    // The sheet's spelling of the same name (srd:spell:hold-person: "Concentration, up to 1 minute").
    const held = setConcentration(knowing('Hold Person'), 'hold person');
    expect(on(held)).toBe('Hold Person');
    expect(messages(held)).toEqual(['Concentrating on Hold Person.']);
    // Invisibility with only See Invisibility on the sheet is Invisibility.
    const unseen = setConcentration(knowing('See Invisibility'), 'Invisibility');
    expect(on(unseen)).toBe('Invisibility');
    expect(messages(unseen)).toEqual(['Concentrating on Invisibility.']);
    // Fireball isn't Delayed Blast Fireball (srd:spell:delayed-blast-fireball: "Concentration, up to 1 minute").
    expect(on(setConcentration(knowing('Delayed Blast Fireball'), 'Fireball'))).toBe('Fireball');
    // H9 still: a looser name for the spell already held ends nothing, nor does the name as recorded.
    const faith = setConcentration(knowing('Shield of Faith'), 'Shield of Faith').character;
    expect(setConcentration(faith, 'Faith')).toEqual({ character: faith, events: [] });
    expect(setConcentration(unseen.character, 'invisibility')).toEqual({ character: unseen.character, events: [] });
  });
});

describe("Mage Armor's Concentration and an exact Concentration (spell effects round 3)", () => {
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const warnings = (r: { events: { type: string; message: string }[] }) => r.events.filter((e) => e.type === 'warning').map((e) => e.message);
  /** An older save: Mira (a wizard, DEX 14, no armor: gear 12) with an AC set by hand for Mage Armor, "concentrating" on it. */
  const robed = (patch: Partial<Character> = {}) => setConcentration(mira({ armorClass: 15, acFormula: 'set by the DM: Mage Armor', ...patch }), 'Mage Armor').character;

  it('an older save\'s Concentration on Mage Armor ending gives no hand-set AC reminder and leaves the AC and its record: Mage Armor needs none (F1/TE2; srd:spell:mage-armor, Duration "8 hours"; srd:rule:concentration: "Some spells and other effects require Concentration")', () => {
    const starts: Array<[string, Character]> = [
      ['15, no record', robed()],
      ['15, recorded', robed({ acSpells: ['Mage Armor'] })],
      ['17 with Haste, recorded', robed({ armorClass: 17, acFormula: 'set by the DM: Mage Armor and Haste', acSpells: ['Mage Armor'] })],
    ];
    for (const [what, start] of starts) {
      expect(start.spellcasting?.concentratingOn, what).toBe('Mage Armor');
      const off = setConcentration(start, null);
      expect(off.events, what).toEqual([{ type: 'condition-removed', message: 'No longer concentrating on Mage Armor.' }]);
      expect(off.character, what).toMatchObject({ armorClass: start.armorClass, acFormula: start.acFormula, spellcasting: { concentratingOn: null } });
      expect(off.character.acSpells, what).toEqual(start.acSpells);
      // Every other path that ends the Concentration: no reminder either, and the AC and the record stay.
      const paths = {
        '0 HP': applyDamage(start, 12),
        Stunned: addCondition(start, { id: 'stunned' }),
        'another spell': setConcentration(start, 'Bless'),
        expire: expireConcentration(start, 'Mage Armor', 'its duration is up'),
        'spell removed': removeSpell(addSpell(start, { name: 'Mage Armor', level: 1, prepared: true }).character, 'Mage Armor'),
      };
      for (const [path, r] of Object.entries(paths)) {
        expect(messages(r).filter((m) => m.includes('set by hand')), `${what}: ${path}`).toEqual([]);
        expect(r.character.armorClass, `${what}: ${path}`).toBe(start.armorClass);
        expect(r.character.acSpells, `${what}: ${path}`).toEqual(start.acSpells);
        expect(r.character.spellcasting?.concentratingOn, `${what}: ${path}`).not.toBe('Mage Armor');
      }
    }
    // Haste's own reminder stands (srd:spell:haste: "+2 bonus to Armor Class"), beside the same Mage Armor, whose base the
    // 15 holds (srd:spell:mage-armor: "the target's base AC becomes 13 plus its Dexterity modifier").
    const hasted = setConcentration(mira({ armorClass: 17, acFormula: 'set by the DM: Mage Armor and Haste', acSpells: ['Mage Armor'] }), 'Haste').character;
    expect(setConcentration(hasted, null).events).toEqual([
      { type: 'condition-removed', message: 'No longer concentrating on Haste.' },
      { type: 'warning', message: 'AC 17 was set by hand for Haste: if it counted Haste, set the AC back to 15 (armor, abilities and Mage Armor).' },
    ]);
    // Mage Armor's own end still reminds the DM of the AC set by hand for it (no record to end).
    expect(warnings(endAcSpell(robed(), 'Mage Armor'))).toEqual([
      "Mage Armor isn't recorded.",
      'AC 15 was set by hand for Mage Armor: if it counted Mage Armor, set the AC back to 12 (armor and abilities).',
    ]);
    // Shield of Faith's record still ends with the Concentration on it (srd:spell:shield-of-faith: "Concentration, up to 10 minutes").
    const faith = addAcSpell(setConcentration(mira(), 'Shield of Faith').character, 'Shield of Faith').character;
    expect(messages(setConcentration(faith, null))).toEqual(['No longer concentrating on Shield of Faith.', 'Shield of Faith ends: AC 14 → 12']);
  });

  it('setConcentration exact: only the very name held is the same spell, never the sheet\'s looser match (F4; srd:spell:invisibility: "Concentration, up to 1 hour"; srd:spell:greater-invisibility: "Concentration, up to 1 minute"; srd:rule:concentration: "Another Concentration Effect")', () => {
    const sheet = (...names: string[]) => ({ ...mira().spellcasting!, spells: names.map((name, i) => ({ id: `s${i}`, name, level: 4, prepared: true, concentration: true })) });
    // Holding Greater Invisibility, with only it on the sheet.
    const holding = setConcentration(mira({ spellcasting: sheet('Greater Invisibility') }), 'Greater Invisibility').character;
    expect(holding.spellcasting?.concentratingOn).toBe('Greater Invisibility');
    // Without exact, the sheet's loose match finds the spell held: nothing changes, as before (H9).
    expect(setConcentration(holding, 'Invisibility')).toEqual({ character: holding, events: [] });
    expect(setConcentration(holding, 'Invisibility', { exact: false })).toEqual({ character: holding, events: [] });
    // With exact, the caller has judged "Invisibility" another spell: Greater Invisibility ends and Invisibility is recorded.
    const switched = setConcentration(holding, 'Invisibility', { exact: true });
    expect(switched.character.spellcasting?.concentratingOn).toBe('Invisibility');
    expect(messages(switched)).toEqual(['Concentration on Greater Invisibility ends (started concentrating on Invisibility).', 'Concentrating on Invisibility.']);
    // The very name held is the same spell, whatever its case and punctuation.
    expect(setConcentration(holding, ' greater-invisibility ', { exact: true })).toEqual({ character: holding, events: [] });
    // E5's label rule is unchanged: a new one in the sheet's spelling of that very name (srd:spell:hold-person:
    // "Concentration, up to 1 minute").
    const both = setConcentration(mira({ spellcasting: sheet('Greater Invisibility', 'Hold Person') }), 'Greater Invisibility').character;
    const held = setConcentration(both, 'hold person', { exact: true });
    expect(held.character.spellcasting?.concentratingOn).toBe('Hold Person');
    expect(messages(held)).toEqual(['Concentration on Greater Invisibility ends (started concentrating on Hold Person).', 'Concentrating on Hold Person.']);
    // So are the refusals for the dead and the Incapacitated, and the end with null.
    expect(setConcentration({ ...holding, deathSaves: { ...holding.deathSaves, dead: true } }, 'Invisibility', { exact: true }).events).toEqual([
      { type: 'warning', message: "The dead can't concentrate." },
    ]);
    const stunned = addCondition(holding, { id: 'stunned' }).character;
    expect(setConcentration(stunned, 'Invisibility', { exact: true }).events).toEqual([{ type: 'warning', message: "Can't concentrate while Stunned." }]);
    expect(messages(setConcentration(holding, null, { exact: true }))).toEqual(['No longer concentrating on Greater Invisibility.']);
  });
});

describe("a Concentration recorded under a sheet copy's noted name is that spell's (spell effects round 4)", () => {
  const messages = (r: { events: { message: string }[] }) => r.events.map((e) => e.message);
  const warnings = (r: { events: { type: string; message: string }[] }) => r.events.filter((e) => e.type === 'warning').map((e) => e.message);
  /** The sheet holds a copy under a noted name (a Spell Scroll's, a multiclass sheet's), and she concentrates on it. */
  const holding = (copy: string, patch: Partial<Character> = {}) =>
    setConcentration(addSpell(mira(patch), { name: copy, level: 1, prepared: true, concentration: true }).character, copy).character;

  it('every path that ends it ends the Shield of Faith record and takes its +2 off (H1/HN1/HX1; srd:spell:shield-of-faith: "Concentration, up to 10 minutes"; srd:rule:concentration: "If the effect\'s creator loses Concentration, the effect ends")', () => {
    for (const copy of ['Shield of Faith (scroll)', 'Shield of Faith (Paladin)']) {
      // Her own casting from the copy, its +2 recorded: AC 14 on her 12 (10 + DEX 2).
      const faithful = () => addAcSpell(holding(copy), 'Shield of Faith').character;
      expect(faithful(), copy).toMatchObject({ armorClass: 14, acFormula: '10 + DEX 2 + Shield of Faith 2', spellcasting: { concentratingOn: copy } });
      const ends = 'Shield of Faith ends: AC 14 → 12';
      const after = (r: { character: Character }, path: string) => {
        expect(r.character, `${copy}: ${path}`).toMatchObject({ armorClass: 12, acFormula: '10 + DEX 2' });
        expect(r.character, `${copy}: ${path}`).not.toHaveProperty('acSpells');
        expect(r.character.spellcasting?.concentratingOn, `${copy}: ${path}`).not.toBe(copy);
      };
      const off = setConcentration(faithful(), null);
      after(off, 'null');
      expect(messages(off)).toEqual([`No longer concentrating on ${copy}.`, ends]);
      // Another spell (srd:rule:concentration, Another Concentration Effect).
      const bless = setConcentration(faithful(), 'Bless');
      after(bless, 'another spell');
      expect(messages(bless)).toEqual([`Concentration on ${copy} ends (started concentrating on Bless).`, ends, 'Concentrating on Bless.']);
      // 0 HP and death (srd:rule:concentration: "Your Concentration ends if you have the Incapacitated condition or you die").
      const down = applyDamage(faithful(), 12);
      after(down, '0 HP');
      expect(messages(down).slice(1)).toEqual([`Concentration on ${copy} ends (Unconscious).`, ends]);
      const dead = applyDamage(faithful(), 29);
      expect(dead.character.deathSaves.dead).toBe(true);
      after(dead, 'death');
      expect(messages(dead).slice(1)).toEqual([`Concentration on ${copy} ends (death).`, ends]);
      // An Incapacitating condition (srd:condition:incapacitated: "Your Concentration is broken").
      const stunned = addCondition(faithful(), { id: 'stunned' });
      after(stunned, 'Stunned');
      expect(messages(stunned).slice(1)).toEqual([`Concentration on ${copy} ends (Stunned).`, ends]);
      // Its time runs out; the copy leaves the sheet.
      const expired = expireConcentration(faithful(), copy, 'its duration is up');
      after(expired, 'expire');
      expect(messages(expired)).toEqual([`Concentration on ${copy} ends: its duration is up.`, ends]);
      const removed = removeSpell(faithful(), copy);
      after(removed, 'removed');
      expect(messages(removed)).toEqual([`Removed spell: ${copy}`, `Concentration on ${copy} ends.`, ends]);
      // A Long Rest (srd:rule:long-rest: "During sleep, you have the Unconscious condition"): the record ends once.
      const rested = applyLongRest(faithful());
      after(rested, 'Long Rest');
      expect(messages(rested)).toEqual([ends, expect.stringMatching(new RegExp(`^Long rest: .*Concentration on ${copy.replace(/[()]/g, '\\$&')} ended\\.$`))]);
    }
  });

  it('an older save\'s Concentration on a noted Mage Armor ends with no hand-set AC reminder (H1/F1; srd:spell:mage-armor, Duration "8 hours")', () => {
    for (const acFormula of ['set by the DM: Mage Armor', 'set by the DM: Mage Armor (scroll)']) {
      const start = setConcentration(mira({ armorClass: 15, acFormula }), 'Mage Armor (scroll)').character;
      expect(start.spellcasting?.concentratingOn).toBe('Mage Armor (scroll)');
      const paths = {
        null: setConcentration(start, null),
        '0 HP': applyDamage(start, 12),
        Stunned: addCondition(start, { id: 'stunned' }),
        'another spell': setConcentration(start, 'Bless'),
        expire: expireConcentration(start, 'Mage Armor (scroll)', 'its duration is up'),
      };
      for (const [path, r] of Object.entries(paths)) {
        expect(warnings(r), `${acFormula}: ${path}`).toEqual([]);
        expect(r.character.armorClass, `${acFormula}: ${path}`).toBe(15);
      }
      expect(messages(paths.null)).toEqual(['No longer concentrating on Mage Armor (scroll).']);
    }
  });

  it('an AC set by hand for Haste gets its reminder when a Concentration on a "Haste (scroll)" copy ends (H1/HX2; srd:spell:haste: "it gains a +2 bonus to Armor Class")', () => {
    // The DM's 14 "set by the DM: Haste" (her 12 + 2), and she concentrates on the sheet's copy.
    const hasted = () => holding('Haste (scroll)', { armorClass: 14, acFormula: 'set by the DM: Haste' });
    const reminder = 'AC 14 was set by hand for Haste (scroll): if it counted Haste (scroll), set the AC back to 12 (armor and abilities).';
    expect(messages(setConcentration(hasted(), null))).toEqual(['No longer concentrating on Haste (scroll).', reminder]);
    expect(warnings(setConcentration(hasted(), 'Bless'))).toEqual([reminder]);
    expect(warnings(addCondition(hasted(), { id: 'stunned' }))).toEqual([reminder]);
    expect(warnings(expireConcentration(hasted(), 'Haste (scroll)', 'its duration is up'))).toEqual([reminder]);
    // A Long Rest: once, after the rest's line.
    expect(warnings(applyLongRest(hasted()))).toEqual([reminder]);
  });

  it("Mage Armor's end on an AC set by hand that counted it, whose number gear now gives too, says the number may still hold it (H3/HA2; srd:spell:mage-armor: \"Until the spell ends, the target's base AC becomes 13 plus its Dexterity modifier\")", () => {
    // F3's advice followed: 12 "set by the DM: cursed (-3) + Mage Armor: 13" (13 + DEX 2 − 3), Mage Armor recorded.
    const cursed = mira({ armorClass: 12, acFormula: 'set by the DM: cursed (-3) + Mage Armor: 13', acSpells: ['Mage Armor'] });
    const ended = endAcSpell(cursed, 'Mage Armor');
    expect(ended.character).toMatchObject({ armorClass: 12, acFormula: 'set by the DM: cursed (-3)' });
    expect(ended.character).not.toHaveProperty('acSpells');
    expect(ended.events).toEqual([
      { type: 'combat', message: 'Mage Armor ends: AC stays 12' },
      { type: 'warning', message: 'AC 12, set by hand, counted Mage Armor, which has ended: if 12 still includes it, set the AC again (armor and abilities give 12).' },
    ]);
    // Shield of Faith's +2 comes off instead (16 under Slow, on Chain Mail 16): 14, and no warning.
    const mail: InventoryItem = { id: 'cm', name: 'Chain Mail', quantity: 1, weight: 55, category: 'armor', equipped: true };
    const slowed = mira({
      armorTraining: ['Heavy armor'],
      inventory: [...mira().inventory, mail],
      armorClass: 16,
      acFormula: 'set by the DM: Slow from the Stone Golem (-2) + Shield of Faith 2',
      acSpells: ['Shield of Faith'],
    });
    expect(endAcSpell(slowed, 'Shield of Faith').events).toEqual([{ type: 'combat', message: 'Shield of Faith ends: AC 16 → 14' }]);
  });
});
