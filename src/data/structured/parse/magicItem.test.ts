import { describe, expect, it } from 'vitest';
import compendiumRaw from '../../../../public/srd/compendium.json?raw';
import { SCRIPTED_WIRE, gloamwoodEntries } from '@/test/structuredFixtures';
import type { CompendiumEntry } from '@/types';
import { normalize } from '../normalize';
import { segment, type Candidate } from '../segment';
import { flatten } from './flatten';
import { itemNouns, itemParagraphs, parseMagicItem, typeLine } from './magicItem';

const CTX = { knownSpellNames: new Set<string>(), knownClassNames: new Set<string>() };
const fixture = (name: string) => segment(gloamwoodEntries(), CTX).candidates.find((c) => c.name === name) as Candidate & { kind: 'magic-item' };
const parseText = (text: string, name = 'Bell of Ash') =>
  parseMagicItem(segment([{ id: 'lib:t:1', sourceId: 't', sourceName: 'T', kind: 'magic-item', name, text, path: ['Magic Items', name] } as CompendiumEntry], CTX).candidates[0] as Candidate & { kind: 'magic-item' });

describe('parseMagicItem', () => {
  it.each(['Lantern of Hollow Light', 'Mothsilk Cloak', "Warden's Mail"])('reads %s as Claude would', (name) => {
    expect(parseMagicItem(fixture(name))).toEqual({ wire: SCRIPTED_WIRE[name].wire, missing: [] });
  });

  it('reads the older type line "requires attunement by a wizard" and its lowercase rarity', () => {
    const { wire } = parseText('*Armor (plate), rare (requires attunement by a wizard)*\n\nYou have a +2 bonus to AC while wearing it.');
    expect(wire).toMatchObject({
      format: '2014', category: 'armor', rarity: 'rare', attunement: 'required-by', attunementText: 'by a wizard', baseItemText: 'plate',
      acBonus: 2, bonusText: '+2 bonus to AC',
    });
  });

  it('reads weapon bonuses, an AC bonus that needs no armor, charges and a varying rarity', () => {
    expect(parseText('_Weapon (Any Sword), Rare_\n\nYou have a +2 bonus to attack rolls and damage rolls made with this magic weapon.').wire).toMatchObject({
      category: 'weapon', baseItemText: 'Any Sword', attackBonus: 2, damageBonus: 2, bonusText: '+2 bonus to attack rolls and damage rolls',
    });
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nYou gain a +2 bonus to AC if you are wearing no armor and using no Shield.').wire).toMatchObject({
      acBonus: 2, acCondition: 'no-armor-no-shield',
    });
    expect(parseText('_Wand, Uncommon_\n\nThis wand has 7 charges.').wire).toMatchObject({ category: 'wand', chargesText: 'has 7 charges' });
    expect(parseText('_Wondrous Item, Rarity Varies_\n\nIt hums.').wire).toMatchObject({ rarity: 'varies' });
    expect(parseText('_Armor (Shield), Uncommon_\n\nIt gleams.').wire).toMatchObject({ category: 'shield', baseItemText: 'Shield' });
  });

  it('reads a type line a PDF joined to the first paragraph: its bonus and charges are in that paragraph', () => {
    const { wire } = parseText(
      'Weapon (Longsword), Legendary (Requires Attunement) You gain a +2 bonus to attack rolls and damage rolls made with this magic weapon. It has 3 charges.',
      'Whisperedge',
    );
    expect(wire).toMatchObject({
      typeLineText: 'Weapon (Longsword), Legendary (Requires Attunement)', category: 'weapon', rarity: 'legendary', attunement: 'required',
      baseItemText: 'Longsword', attackBonus: 2, damageBonus: 2, chargesText: 'has 3 charges',
    });
    // A rarity word in the description doesn't change the item's rarity.
    expect(parseText('Wondrous Item, Rare (Requires Attunement) This brooch looks like a common copper pin. You gain a +1 bonus to saving throws while you wear it.', 'Copperpin Brooch').wire).toMatchObject({
      typeLineText: 'Wondrous Item, Rare (Requires Attunement)', rarity: 'rare', saveBonus: 1,
    });
  });

  it('leaves out a bonus that holds only in some situations, and one variant’s bonus', () => {
    const none = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0, bonusText: '' };
    expect(parseText('_Armor (Shield), Rare (Requires Attunement)_\n\nWhile holding this Shield, you gain a +2 bonus to Armor Class against attacks made by Fiends.').wire).toMatchObject(none);
    expect(parseText('_Wondrous Item, Rare_\n\nWhen you are hit by an attack while wearing this cloak, you can take a Reaction to gain a +3 bonus to AC against that attack.').wire).toMatchObject(none);
    expect(parseText('_Potion, Uncommon_\n\nWhen you drink this potion, you gain a +2 bonus to Armor Class for 1 hour.').wire).toMatchObject(none);
    expect(parseText('_Wondrous Item, Rare_\n\nWhile in that Bright Light, you gain a +1 bonus to AC and saving throws.').wire).toMatchObject(none);
    expect(parseText('_Wondrous Item, Rarity Varies_\n\nProtection (Rare). You gain a +1 bonus to AC while this stone orbits your head.').wire).toMatchObject(none);
    // A weapon's own bonus stays; an example of moving it doesn't add one.
    expect(parseText('_Weapon (Any Sword), Legendary (Requires Attunement)_\n\nYou gain a +3 bonus to attack rolls and damage rolls made with this magic weapon. For example, you could reduce the bonus to your attack and damage rolls to +1 and gain a +2 bonus to AC.').wire).toMatchObject({
      attackBonus: 3, damageBonus: 3, acBonus: 0,
    });
    // An item that always grants its bonus while worn keeps it.
    expect(parseText('_Wondrous Item, Uncommon (Requires Attunement)_\n\nYou gain a +1 bonus to AC and saving throws while you wear this cloak.').wire).toMatchObject({ acBonus: 1, saveBonus: 1 });
  });

  it('judges a bonus by its own clause, not by the rest of its sentence', () => {
    // A save "against" something in another clause, or charges the item has, doesn't make the bonus situational.
    expect(parseText('_Armor (Scale Mail), Very Rare (Requires Attunement)_\n\nWhile wearing this armor, you gain a +1 bonus to Armor Class, you have Advantage on saving throws against the breath of moths, and you have Resistance to Fire.').wire).toMatchObject({ acBonus: 1, saveBonus: 0 });
    expect(parseText('_Staff, Legendary (Requires Attunement)_\n\nThis staff has 40 charges and can be wielded as a magic Quarterstaff that grants a +2 bonus to attack rolls and damage rolls made with it.').wire).toMatchObject({ attackBonus: 2, damageBonus: 2, chargesText: 'has 40 charges' });
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nOnce you attune to this circlet, you gain a +1 bonus to saving throws.').wire).toMatchObject({ saveBonus: 1 });
    expect(parseText('_Wondrous Item, Rare_\n\nYou gain a +1 bonus to saving throws while in your possession.').wire).toMatchObject({ saveBonus: 1 });
    expect(parseText('_Wondrous Item, Rare_\n\nYou gain a +1 bonus to Armor Class while you wear this cloak; if the cloak is torn, it mends by dawn.').wire).toMatchObject({ acBonus: 1 });
    expect(parseText('_Weapon (Longsword), Rare_\n\nYou gain a +1 bonus to attack rolls and damage rolls made with this magic weapon, which hums softly when drawn.').wire).toMatchObject({ attackBonus: 1, damageBonus: 1 });
    expect(parseText('_Wondrous Item, Uncommon (Requires Attunement)_\n\nWhile this pebble is on your person, you gain a +1 bonus to ability checks and saving throws.').wire).toMatchObject({ saveBonus: 1 });
    // The situation stands in the bonus's clause, or opens its sentence.
    expect(parseText('_Weapon (Mace), Rare_\n\nWhen you hit a creature with this weapon, you gain a +1 bonus to AC.').wire).toMatchObject({ acBonus: 0 });
    expect(parseText('_Wondrous Item, Uncommon (Requires Attunement)_\n\nWhile wearing these bracers, you gain a +2 bonus to damage rolls made with such weapons.').wire).toMatchObject({ damageBonus: 0 });
  });

  it('leaves out every variant’s bonus, even when a PDF joined the variants into one paragraph', () => {
    const joined = '_Wondrous Item, Rarity Varies (Requires Attunement)_\n\nEach stone orbits your head. Glow (Uncommon). This pale stone sheds Dim Light. Ward (Rare). You gain a +1 bonus to Armor Class while this grey stone orbits your head.';
    expect(parseText(joined).wire).toMatchObject({ acBonus: 0, bonusText: '' });
    // Not a variant: a lowercase "the stone (rare)" in a sentence.
    expect(parseText('_Wondrous Item, Rare_\n\nthe stone (rare). You gain a +1 bonus to Armor Class while you carry it.').wire).toMatchObject({ acBonus: 1 });
  });

  it('cuts a type line only where prose was joined onto it, keeping every rarity and parenthetical', () => {
    expect(parseText('_Wondrous Item, Rare or Very Rare (Requires Attunement)_\n\nYou gain a +1 bonus to Armor Class while you wear it.').wire).toMatchObject({
      typeLineText: 'Wondrous Item, Rare or Very Rare (Requires Attunement)', rarity: 'varies', attunement: 'required', acBonus: 1,
    });
    expect(parseText('_Potion, Uncommon or Rare_\n\nYou glow.').wire).toMatchObject({ typeLineText: 'Potion, Uncommon or Rare', rarity: 'varies' });
    expect(parseText('_Wondrous Item (Common Clothes), Uncommon (Requires Attunement)_\n\nWhile you wear these clothes, you gain a +1 bonus to saving throws.').wire).toMatchObject({
      typeLineText: 'Wondrous Item (Common Clothes), Uncommon (Requires Attunement)', category: 'wondrous-item', rarity: 'uncommon', attunement: 'required', baseItemText: 'Common Clothes', saveBonus: 1,
    });
    // Joined by a PDF: the line ends after its last rarity and parentheticals; the rest is the item's text.
    expect(parseText('Weapon (Any Simple or Martial), Uncommon (+1), Rare (+2), or Very Rare (+3) (Requires Attunement by a Spellcaster) You gain a +2 bonus to attack rolls made with it.').wire).toMatchObject({
      typeLineText: 'Weapon (Any Simple or Martial), Uncommon (+1), Rare (+2), or Very Rare (+3) (Requires Attunement by a Spellcaster)', rarity: 'varies', attunement: 'required-by', attackBonus: 2,
    });
    expect(typeLine('Wondrous Item, Uncommon This lamp burns without oil.')).toEqual({ line: 'Wondrous Item, Uncommon', raw: 'Wondrous Item, Uncommon This lamp burns without oil.', rest: 'This lamp burns without oil.' });
    // A line that stands alone is never cut.
    expect(typeLine('_Wondrous Item, Common (Requires Attunement) or Uncommon_').line).toBe('Wondrous Item, Common (Requires Attunement) or Uncommon');
  });

  it("knows the nouns an item's text names it by: its name's, its category and its base item", () => {
    expect(itemNouns('Ring of Warmth', 'Ring, Uncommon (Requires Attunement)')).toEqual(['ring']);
    expect(itemNouns('Warden Token', 'Wondrous Item, Rare')).toEqual(['token', 'item']);
    expect(itemNouns('Elven Chain', 'Armor (Chain Mail or Chain Shirt), Rare')).toEqual(['chain', 'armor', 'mail', 'shirt']);
    expect(itemNouns('Stone of Good Luck (Luckstone)', 'Wondrous Item, Uncommon (Requires Attunement)')).toEqual(['stone', 'item']);
    expect(itemNouns('Frost Brand', 'Weapon (Any Sword), Very Rare (Requires Attunement)')).toEqual(['brand', 'weapon', 'sword']);
  });

  it('applies an always-on bonus only when its item phrase names the item, ending that phrase at its noun', () => {
    // "the <noun>" with the item's own noun; any listed noun (or its own) after "this"; a word after the noun is left over.
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you carry the token, you gain a +1 bonus to saving throws.', 'Warden Token').wire).toMatchObject({ saveBonus: 1 });
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you hold the torch, you gain a +1 bonus to saving throws.', 'Warden Token').wire).toMatchObject({ saveBonus: 0 });
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you carry this thurible, you gain a +1 bonus to saving throws.', 'Thurible of Embers').wire).toMatchObject({ saveBonus: 1 });
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you carry this frobnitz, you gain a +1 bonus to saving throws.', 'Warden Token').wire).toMatchObject({ saveBonus: 0 });
    expect(parseText('_Staff, Rare_\n\nWhile you hold this staff upright, you gain a +1 bonus to AC.', 'Heron Staff').wire).toMatchObject({ acBonus: 0 });
    expect(parseText('_Weapon (Greatsword), Rare_\n\nWhile you wield this two-handed sword, you gain a +1 bonus to attack rolls.', 'Heron Blade').wire).toMatchObject({ attackBonus: 1 });
    // The wearer's bonus, not another creature's.
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you wear this collar, your familiar gains a +1 bonus to Armor Class.', 'Hound Collar').wire).toMatchObject({ acBonus: 0 });
  });

  it('reads a paragraph a PDF broke off mid-sentence together with the next, when that starts in lower case', () => {
    expect(itemParagraphs('_Armor (Breastplate), Rare_\n\nYou have a +1 bonus to Armor Class\n\nwhile you are Bloodied.')).toEqual(['You have a +1 bonus to Armor Class while you are Bloodied.']);
    expect(itemParagraphs('_Weapon (Longsword), Rare_\n\nWhen you wield this sword two-\n\nhanded, you have a +1 bonus to AC.')).toEqual(['When you wield this sword two-handed, you have a +1 bonus to AC.']);
    // A sentence that ends, or a capital (a variant's run-in), starts a paragraph of its own.
    expect(itemParagraphs('_Ring, Rarity Varies_\n\nThis ring comes in several kinds\n\nRuby (Rare). It glows.')).toEqual(['This ring comes in several kinds', 'Ruby (Rare). It glows.']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nIt hums.\n\nthe stone glows.')).toEqual(['It hums.', 'the stone glows.']);
    // A closing paragraph after the variants: "These rings have 3 charges" counts for the item.
    expect(parseText('_Ring, Rarity Varies_\n\nRuby (Rare). It glows.\n\nSapphire (Very Rare). It hums.\n\nThese rings have 3 charges.', 'Warden Ring').wire).toMatchObject({ chargesText: 'have 3 charges' });
  });

  it('keeps list items as paragraphs of their own, and parts the ones a PDF ran together (D1)', () => {
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou gain the following benefits:\n\n- **Ward.** You have a +1 bonus to AC.\n- **Sight.** You can see in the dark.')).toEqual([
      'You gain the following benefits:',
      '- Ward. You have a +1 bonus to AC.',
      '- Sight. You can see in the dark.',
    ]);
    // A PDF ran the items together, or the intro into them.
    expect(itemParagraphs('_Wondrous Item, Rare_\n\n- Ward. You have a +1 bonus to AC. - Sight. You can see in the dark.')).toEqual(['- Ward. You have a +1 bonus to AC.', '- Sight. You can see in the dark.']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou gain the following benefits: Ward. You have a +1 bonus to AC.')).toEqual(['You gain the following benefits:', 'Ward. You have a +1 bonus to AC.']);
  });

  it('joins a paragraph a PDF broke before a capital when it ends where a sentence can\'t, unless the next starts on its own (D5)', () => {
    expect(itemParagraphs('_Armor (Shield), Rare_\n\nYou gain a +2 bonus to Armor Class while you hold this\n\nShield raised before you.')).toEqual(['You gain a +2 bonus to Armor Class while you hold this Shield raised before you.']);
    expect(itemParagraphs('_Staff, Very Rare_\n\nWhile holding it, you gain a +2 bonus to Armor\n\nClass, saving throws, and spell attack rolls.')).toEqual(['While holding it, you gain a +2 bonus to Armor Class, saving throws, and spell attack rolls.']);
    expect(itemParagraphs('_Staff, Very Rare_\n\nThis staff can be wielded as a magic\n\nQuarterstaff that grants a +3 bonus to attack rolls.')).toEqual(['This staff can be wielded as a magic Quarterstaff that grants a +3 bonus to attack rolls.']);
    // I5: where the first part can't end a sentence, a one-to-three-word "label" after it is the cut sentence's end.
    expect(itemParagraphs('_Armor (Plate Armor), Very Rare_\n\nWhile wearing this armor, you gain a +2 bonus to\n\nArmor Class. In addition, you can take a Reaction.')).toEqual(['While wearing this armor, you gain a +2 bonus to Armor Class. In addition, you can take a Reaction.']);
    expect(itemParagraphs('_Weapon (Longsword), Rare_\n\nIt deals Radiant damage instead of\n\nSlashing damage. When you hit, it glows.')).toEqual(['It deals Radiant damage instead of Slashing damage. When you hit, it glows.']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou gain a +1 bonus to\n\nWard. You can see in the dark.')).toEqual(['You gain a +1 bonus to Ward. You can see in the dark.']);
    // I5: with no closing ". ! ?", "(" or a dash goes on in any case; so does what follows an open parenthesis.
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou have a +1 bonus to Armor Class\n\n(only while you are in Dim Light).')).toEqual(['You have a +1 bonus to Armor Class (only while you are in Dim Light).']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou have a +1 bonus to Armor Class\n\n— but only in Dim Light.')).toEqual(['You have a +1 bonus to Armor Class — but only in Dim Light.']);
    expect(itemParagraphs('_Armor (Shield), Rare_\n\nGuard (Shield\n\nForm Only). You have a +1 bonus to AC.')).toEqual(['Guard (Shield Form Only). You have a +1 bonus to AC.']);
    // A variant's run-in, a list item, a sentence's end or an intro's ":" keeps the next paragraph apart.
    expect(itemParagraphs('_Ring, Rarity Varies_\n\nThis ring comes in several kinds of\n\nRuby (Rare). It glows.')).toEqual(['This ring comes in several kinds of', 'Ruby (Rare). It glows.']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nIt hums.\n\nShield yourself.')).toEqual(['It hums.', 'Shield yourself.']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou gain the following benefits:\n\nWard. You have a +1 bonus to AC.')).toEqual(['You gain the following benefits:', 'Ward. You have a +1 bonus to AC.']);
    // A bonus whose sentence a break still cuts isn't applied.
    expect(parseText('_Wondrous Item, Rare_\n\nRavens are stitched on its hem. You gain a +1 bonus to AC while you hold this\n\nWard. You can see in the dark.').wire).toMatchObject({ acBonus: 0 });
  });

  it('reads who has the bonus, what leads into its clause, and a limit in another sentence (D2–D4)', () => {
    const none = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0 };
    // D4: you, the wearer or the item, giving it to you.
    expect(parseText('_Rod, Rare_\n\nWhile you hold this rod, Undead you control gain a +1 bonus to attack rolls.', 'Rod of Bones').wire).toMatchObject(none);
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you carry it, this banner grants your allies a +1 bonus to saving throws.', 'War Banner').wire).toMatchObject(none);
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you carry it, this banner grants you a +1 bonus to saving throws.', 'War Banner').wire).toMatchObject({ saveBonus: 1 });
    expect(parseText('_Staff, Legendary_\n\nThis staff has 40 charges and can be wielded as a magic Quarterstaff that grants a +2 bonus to attack rolls and damage rolls made with it.', 'Heron Staff').wire).toMatchObject({ attackBonus: 2, damageBonus: 2 });
    // D3: a lead-in before any subject, with or without its comma, and a parenthetical after it.
    expect(parseText('_Wondrous Item, Rare_\n\nBy moonlight the cloak grants a +1 bonus to Armor Class.', 'Cloak of Night').wire).toMatchObject(none);
    expect(parseText('_Armor (Shield), Rare_\n\nThe shield, once activated, grants a +1 bonus to Armor Class.', 'Raven Shield').wire).toMatchObject(none);
    expect(parseText('_Ring, Rare_\n\nThis ring, while worn, grants a +1 bonus to Armor Class.', 'Warden Ring').wire).toMatchObject({ acBonus: 1 });
    // D2: the item's no-armor restriction sets the AC condition, whichever sentence says it.
    expect(parseText('_Wondrous Item, Rare_\n\nThese bracers work only if you wear no armor and use no Shield. While wearing them, you gain a +2 bonus to Armor Class.', 'Warden Bracers').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor-no-shield' });
    expect(parseText('_Wondrous Item, Rare_\n\nYou gain a +1 bonus to AC and saving throws while you wear this cloak. The AC bonus applies only in Dim Light.', 'Moth Cloak').wire).toMatchObject({ acBonus: 0, saveBonus: 1 });
    // D7: a variant's run-in with a colon.
    expect(parseText('_Armor (Shield), Rarity Varies_\n\nOak (Uncommon): While you hold this Shield, you have a +1 bonus to saving throws.', 'Warden Shield').wire).toMatchObject(none);
  });

  it('keeps a heading or a bold line inside an item as a paragraph of its own (I6), and a bold sentence as prose', () => {
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nYou gain the following benefits.\n\n#### Pressure Ward\n\nYou have a +1 bonus to AC.')).toEqual([
      'You gain the following benefits.',
      '# Pressure Ward',
      'You have a +1 bonus to AC.',
    ]);
    expect(itemParagraphs('_Ring, Rarity Varies_\n\n**Oak (Uncommon)**\nWhile you wear it, you have a +1 bonus to AC.')).toEqual(['# Oak (Uncommon)', 'While you wear it, you have a +1 bonus to AC.']);
    expect(itemParagraphs('### Warden Ring\n\n_Ring, Rare_\n\n**While you wear this ring, you have a +1 bonus to AC.**')).toEqual(['While you wear this ring, you have a +1 bonus to AC.']);
  });

  it('reads the round-6 decisions at the wire level (I1, I10, I11)', () => {
    const none = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0 };
    // I1: armor worn where the bracers don't work sets the no-armor condition for AC; a restriction in the bonus's own sentence is read.
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nWhile wearing these bracers, you gain a +2 bonus to Armor Class. If you wear armor or use a Shield, these bracers have no effect.', 'Warden Bracers').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor-no-shield' });
    expect(parseText('_Wondrous Item, Rare_\n\nYou gain a +1 bonus to Armor Class while you wear this cloak, which doesn\'t function in sunlight.', 'Moth Cloak').wire).toMatchObject(none);
    expect(parseText('_Wondrous Item, Rare_\n\nThis cloak works only at night, and while you wear it, you gain a +1 bonus to Armor Class.', 'Moth Cloak').wire).toMatchObject(none);
    // I10: a choice applies neither alternative.
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you wear this amulet, you gain a +1 bonus to Armor Class or a +1 bonus to saving throws.', 'Fen Amulet').wire).toMatchObject(none);
    // I11: the item or its wearer named other ways.
    expect(parseText('_Armor (Scale Mail), Rare_\n\nThis armor has a +1 bonus to Armor Class.', 'Warden Scales').wire).toMatchObject({ acBonus: 1 });
    expect(parseText('_Ring, Rare_\n\nWearing this ring grants you a +1 bonus to saving throws.', 'Fen Ring').wire).toMatchObject({ saveBonus: 1 });
    expect(parseText('_Wondrous Item, Rare_\n\nWhile you hold this banner, you and allies within 10 feet of you gain a +1 bonus to saving throws.', 'Fen Banner').wire).toMatchObject({ saveBonus: 1 });
  });

  it('reads the round-7 decisions at the wire level (J1–J7, O1–O5)', () => {
    const none = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0 };
    const W = '_Wondrous Item, Rare (Requires Attunement)_';
    // J1: a colon line is an intro that governs its list; one that says the item is attuned holds; a no-armor one sets the condition.
    expect(parseText(`${W}\n\nThis cloak is woven from kelp.\n\nWhile raging:\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.`, 'Cloak of the Deep').wire).toMatchObject(none);
    expect(parseText(`${W}\n\nThis cloak is woven from kelp.\n\nWhile attuned:\n\n- You have a +1 bonus to Armor Class.`, 'Cloak of the Deep').wire).toMatchObject({ acBonus: 1, acCondition: 'always' });
    expect(parseText(`${W}\n\nIf you wear no armor:\n\n- You have a +2 bonus to Armor Class.`, 'Warden Bracers').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor' });
    // J1: a heading governs every list item after it; J2: one between a bonus and its limit doesn't stop the limit.
    expect(parseText(`${W}\n\n#### Underwater\n\n- You can breathe water.\n- You have a +1 bonus to Armor Class.`, 'Cloak of the Deep').wire).toMatchObject(none);
    expect(parseText(`${W}\n\nWhile you wear this cloak, you have a +1 bonus to Armor Class.\n\n#### Drawback\n\nThis bonus doesn't apply in sunlight.`, 'Cloak of the Deep').wire).toMatchObject(none);
    // J3: the item's full name, an aside or "But" before its verb; the bracers keep their no-armor reading.
    expect(parseText(`${W}\n\nWhile you wear this cloak, you have a +1 bonus to Armor Class. The Cloak of the Deep doesn't function in sunlight.`, 'Cloak of the Deep').wire).toMatchObject(none);
    expect(parseText(`${W}\n\nWhile wearing these bracers, you gain a +2 bonus to Armor Class. These bracers, however, don't function if you wear armor or use a Shield.`, 'Warden Bracers').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor-no-shield' });
    // J4: a lead-in after an always-on opening; J5: a limit beside a reuse limit; J6: an item reference before the bonus.
    expect(parseText(`${W}\n\nWhile you wear this cloak, if you are Bloodied, you can't be Frightened, and you gain a +1 bonus to Armor Class.`, 'Moth Cloak').wire).toMatchObject(none);
    expect(parseText(`${W}\n\nWhile you wear this cloak, you have a +1 bonus to Armor Class. When you are Bloodied, this benefit ends, and you can't use it again until you finish a Long Rest.`, 'Moth Cloak').wire).toMatchObject(none);
    expect(parseText(`${W}\n\nThe cloak's magic fails in sunlight, but while you wear it, you have a +1 bonus to Armor Class.`, 'Moth Cloak').wire).toMatchObject(none);
    // J7: what isn't said of the item's working restricts nothing.
    expect(parseText('_Armor (Plate Armor), Rare_\n\nWhile you wear this armor, you have a +1 bonus to Armor Class. The armor can\'t be damaged by nonmagical weapons.', 'Warden Plate').wire).toMatchObject({ acBonus: 1 });
    // O2–O4: "renders … useless" with the no-armor reading, a reference later in a bonus-less paragraph, a later choice.
    expect(parseText(`${W}\n\nWhile wearing these bracers, you gain a +2 bonus to Armor Class. Wearing armor or using a Shield renders these bracers useless.`, 'Warden Bracers').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor-no-shield' });
    expect(parseText(`${W}\n\nYou gain a +1 bonus to Armor Class while you wear this cloak.\n\nThe cloak smells of the sea. The bonus doesn't apply in sunlight.`, 'Moth Cloak').wire).toMatchObject(none);
    expect(parseText(`${W}\n\nWhile you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. At dawn, choose one of the two bonuses.`, 'Fen Amulet').wire).toMatchObject(none);
    // A bullet a column ended right after goes on in the next paragraph, a list item again.
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nWhile raging:\n\n• You can breathe water.\n\n•\n\nYou have a +1 bonus to AC.')).toEqual(['While raging:', '- You can breathe water.', '• You have a +1 bonus to AC.']);
    expect(itemParagraphs('_Wondrous Item, Rare_\n\nWhile raging:\n\n• You can breathe water. •\n\nYou have a +1 bonus to AC.')).toEqual(['While raging:', '- You can breathe water.', '• You have a +1 bonus to AC.']);
  });

  it("reads the round-7 layout review's findings at the wire level (F1–F6)", () => {
    const none = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0 };
    const W = '_Wondrous Item, Rare (Requires Attunement)_';
    const srd = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'magic-item');
    /** An SRD 5.2.1 item's type line, an always-on +1 to AC and saving throws, then its paragraph that holds `words` (or `words` itself). */
    const srdItem = (name: string, words: string, whole = true) => {
      const paragraphs = srd.find((e) => e.name === name)?.text.split(/\n\s*\n/) ?? [];
      const paragraph = whole ? paragraphs.find((p) => p.includes(words)) : words;
      expect(paragraph, name).toBeTruthy();
      return `${paragraphs[0]}\n\nYou have a +1 bonus to Armor Class and saving throws.\n\n${paragraph}`;
    };
    // F1: a failing heading governs past a list item's second paragraph and a converter line between bullets.
    const kelp = (between: string) => `${W}\n\nThis cloak is woven from kelp.\n\n#### Underwater\n\n- You have Resistance to Cold damage.\n\n${between}\n\n- You have a +1 bonus to Armor Class.`;
    expect(parseText(kelp('  This Resistance ends if you leave the water.'), 'Cloak of the Deep').wire).toMatchObject(none);
    expect(parseText(kelp('\\column'), 'Cloak of the Deep').wire).toMatchObject(none);
    // F2: a no-armor heading or intro keeps its condition past the second paragraph.
    const hand = (lead: string) => `${W}\n\nThese bracers are made of hardened leather.\n\n${lead}\n\n- You have Advantage on Dexterity saving throws.\n\n  This benefit doesn't stack with Evasion.\n\n- You have a +2 bonus to Armor Class.`;
    expect(parseText(hand('#### While Wearing No Armor'), 'Bracers of the Open Hand').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor' });
    expect(parseText(hand('If you wear no armor and use no Shield:'), 'Bracers of the Open Hand').wire).toMatchObject({ acBonus: 2, acCondition: 'no-armor-no-shield' });
    // F3: an SRD paragraph's own effect, property or magic doesn't reach back; a reference to a bonus still does.
    expect(parseText(srdItem('Gauntlets of Ogre Power', 'They have no effect on you'), 'Gauntlets of Ogre Power').wire).toMatchObject({ acBonus: 1, saveBonus: 1 });
    expect(parseText(srdItem('Cloak of Invisibility', 'The effect ends early'), 'Cloak of Invisibility').wire).toMatchObject({ acBonus: 1, saveBonus: 1 });
    expect(parseText(`${srdItem('Gauntlets of Ogre Power', 'They have no effect on you')} These bonuses apply only while you are in Dim Light or Darkness.`, 'Gauntlets of Ogre Power').wire).toMatchObject(none);
    // F4: spent uses, a preposition's object and a leading If-clause's item restrict nothing; a condition still does.
    expect(parseText(srdItem('Chime of Opening', 'After the tenth time, it cracks and becomes useless.', false), 'Chime of Opening').wire).toMatchObject({ acBonus: 1, saveBonus: 1 });
    expect(parseText(srdItem('Sending Stones', 'If one of the stones in a pair is destroyed, the other one becomes nonmagical.', false), 'Sending Stones').wire).toMatchObject({ acBonus: 1, saveBonus: 1 });
    expect(parseText(srdItem('Mysterious Deck', 'Any cards drawn in excess of this number have no effect.', false), 'Mysterious Deck').wire).toMatchObject({ acBonus: 1, saveBonus: 1 });
    expect(parseText(`${W}\n\nWhile you wear this cloak, you have a +1 bonus to Armor Class. After you take damage, the cloak becomes useless.`, 'Cloak of the Fen').wire).toMatchObject(none);
    // F5: a colon label line with no condition holds; one with a condition doesn't.
    const gray = (lead: string) => `${W}\n\nThis cloak is woven from gray wool.\n\n${lead}\n\n- You have a +1 bonus to Armor Class.\n- You have Resistance to Cold damage.`;
    expect(parseText(gray('Benefits:'), 'Cloak of the Gray Ward').wire).toMatchObject({ acBonus: 1 });
    expect(parseText(gray('While raging:'), 'Cloak of the Gray Ward').wire).toMatchObject(none);
    // F6: a label alone that names a condition governs its own text, up to the next run-in.
    expect(parseText(`${W}\n\nThis cloak is woven from shadow and smells of smoke.\n\nNight Sight.\n\nYou can see in Darkness out to 60 feet.\n\nWard. While you wear this cloak, you have a +1 bonus to Armor Class.`, 'Cloak of Dusk').wire).toMatchObject({ acBonus: 1 });
  });

  it("reads the round-7 grammar review's findings at the wire level (F1–F8)", () => {
    const none = { acBonus: 0, saveBonus: 0, attackBonus: 0, damageBonus: 0 };
    const cloak = (rest: string) => parseText(`_Wondrous Item, Rare (Requires Attunement)_\n\nWhile you wear this cloak, you have a +1 bonus to Armor Class. ${rest}`, 'Cloak of the Fen').wire;
    // F1: a limit joined to a reuse limit (", after which", "and then", an aside) is still a limit; a reuse limit alone isn't.
    expect(cloak("The bonus ends when you are Bloodied, after which it can't be used again until the next dawn.")).toMatchObject(none);
    expect(cloak("The bonus lasts until you are Bloodied and then can't be used again until the next dawn.")).toMatchObject(none);
    expect(cloak("This benefit, which ends when you are Bloodied, can't be used again until the next dawn.")).toMatchObject(none);
    expect(cloak("You can cast Fly from the cloak, after which it can't be used this way again until the next dawn.")).toMatchObject({ acBonus: 1 });
    // F2: a negated protect or extend scoped to attacks restricts; one scoped to a damage type doesn't.
    expect(parseText("_Armor (Shield), Rare (Requires Attunement)_\n\nWhile holding this Shield, you have a +2 bonus to Armor Class. The shield doesn't protect you from ranged attacks.", 'Raven Shield').wire).toMatchObject(none);
    expect(parseText("_Wondrous Item, Rare (Requires Attunement)_\n\nThe cloak's protection doesn't extend to ranged attacks, but while you wear it, you have a +1 bonus to Armor Class.", 'Cloak of the Fen').wire).toMatchObject(none);
    expect(cloak("The cloak doesn't protect you from Psychic damage.")).toMatchObject({ acBonus: 1 });
    // F3: "functions as", "is magically inert" and "is treated as" are states of the item.
    expect(cloak('In sunlight, the cloak functions as a nonmagical cloak.')).toMatchObject(none);
    expect(cloak('The cloak is treated as nonmagical while you are in sunlight.')).toMatchObject(none);
    expect(parseText('_Ring, Rare (Requires Attunement)_\n\nWhile you wear this ring, you have a +1 bonus to Armor Class and saving throws. Underwater, the ring is magically inert.', 'Ring of the Reed').wire).toMatchObject(none);
    // F4: a concession stacked after an always-on opening holds; a condition there doesn't.
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nWhile you wear this cloak, even when you are Unconscious, your steps make no sound, and you have a +1 bonus to Armor Class.', 'Cloak of the Fen').wire).toMatchObject({ acBonus: 1 });
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nWhile you wear this cloak, whether or not you are Bloodied, shadows cling to you, and you have a +1 bonus to Armor Class.', 'Cloak of the Fen').wire).toMatchObject({ acBonus: 1 });
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nWhile you wear this cloak, if you are Bloodied, your steps make no sound, and you have a +1 bonus to Armor Class.', 'Cloak of the Fen').wire).toMatchObject(none);
    // F5: "choose one of the following properties" offers what follows; "choose one of these bonuses" chooses among the bonuses.
    expect(cloak('When you attune to the cloak, choose one of the following properties: Resistance to Fire damage or Resistance to Cold damage.')).toMatchObject({ acBonus: 1 });
    expect(parseText('_Wondrous Item, Rare (Requires Attunement)_\n\nWhile you wear this amulet, you have a +1 bonus to Armor Class and a +1 bonus to saving throws. When you attune to the amulet, choose one of these bonuses.', 'Amulet of the Fen').wire).toMatchObject(none);
    // F6: a colon run-in label with no condition holds; the sentence after it is judged on its own.
    expect(parseText("_Armor (Plate Armor), Rare (Requires Attunement)_\n\nWhile you wear this armor, you have a +1 bonus to Armor Class.\n\n**Stealth:** The armor doesn't impose Disadvantage on Dexterity (Stealth) checks.", 'Warden Plate').wire).toMatchObject({ acBonus: 1 });
    expect(parseText("_Wondrous Item, Rare (Requires Attunement)_\n\nWhile you wear this cloak, you have a +1 bonus to Armor Class.\n\n_**Weakness:**_ The cloak doesn't function in sunlight.", 'Cloak of the Fen').wire).toMatchObject(none);
    // F7: an object restriction needs the wearer as its subject and no negation before it.
    expect(cloak('Other creatures gain no benefit from the cloak.')).toMatchObject({ acBonus: 1 });
    expect(cloak('No mortal magic can render the cloak powerless.')).toMatchObject({ acBonus: 1 });
    expect(cloak('Sunlight renders the cloak powerless.')).toMatchObject(none);
    // F8: the backstop reads neither a spell's failing nor an adverbial "only" away from a works-verb; the item working only so it reads.
    expect(cloak("Once per day, you can cast Charm Person from the cloak; the spell doesn't work on Undead.")).toMatchObject({ acBonus: 1 });
    expect(parseText('_Armor (Plate Armor), Rare (Requires Attunement)_\n\nWhile you wear this armor, you have a +1 bonus to Armor Class. Dwarven smiths forged this armor only for their kings.', 'Warden Plate').wire).toMatchObject({ acBonus: 1 });
    expect(cloak('The cloak, a relic of the old kings who ruled the north long ago, works only at night.')).toMatchObject(none);
  });

  it('lists what it could not read', () => {
    expect(parseText('A legend about a bell.').missing).toEqual(['typeLineText', 'category', 'rarity']);
  });

  it('reads a type line after the item\'s name and a dash, even when the name starts with a category word', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['Ring of Protection — Ring, Rare (Requires Attunement)', { typeLineText: 'Ring, Rare (Requires Attunement)', category: 'ring', rarity: 'rare', attunement: 'required' }],
      ['Ring of Warmth — Ring, Uncommon (Requires Attunement)', { typeLineText: 'Ring, Uncommon (Requires Attunement)', category: 'ring', rarity: 'uncommon', attunement: 'required' }],
      ['Ring of Warmth – Ring, Uncommon (Requires Attunement)', { category: 'ring', rarity: 'uncommon' }],
      ['Ring of Warmth - Ring, Uncommon (Requires Attunement)', { typeLineText: 'Ring, Uncommon (Requires Attunement)', category: 'ring' }],
      ['Ring of Warmth — ring, uncommon (requires attunement)', { category: 'ring', rarity: 'uncommon', attunement: 'required', format: '2014' }],
      ['Staff of Power — Staff, Very Rare (Requires Attunement by a Sorcerer, Warlock, or Wizard)', { category: 'staff', rarity: 'very rare', attunement: 'required-by', attunementText: 'by a Sorcerer, Warlock, or Wizard' }],
      ['Armor of the Deep — Armor (Scale Mail), Rare (Requires Attunement)', { category: 'armor', baseItemText: 'Scale Mail', rarity: 'rare' }],
      ['Armor of the Deep - Armor (scale mail), rare (requires attunement)', { category: 'armor', baseItemText: 'scale mail', rarity: 'rare' }],
      // A name that starts with another category word, or holds a parenthesis.
      ['Shield Guardian Amulet — Wondrous Item, Rare (Requires Attunement)', { category: 'wondrous-item', rarity: 'rare' }],
      ['Potion Belt — Wondrous Item, Uncommon', { category: 'wondrous-item', rarity: 'uncommon', attunement: 'none' }],
      ['Stone of Quiet Luck (Quietstone) — Wondrous Item, Uncommon (Requires Attunement)', { typeLineText: 'Wondrous Item, Uncommon (Requires Attunement)', category: 'wondrous-item' }],
      // A type line that ends in a parenthesis or a dash is read whole: neither is after a name.
      ['Shield, Rare (shield +1)', { typeLineText: 'Shield, Rare (shield +1)', category: 'shield', rarity: 'rare' }],
      ['Armor (Scale Mail), Rare — Armor of the Deep', { category: 'armor', baseItemText: 'Scale Mail', rarity: 'rare' }],
    ];
    for (const [line, want] of cases) {
      const { wire, missing } = parseText(`_${line}_\n\nWhile you wear it, you have a +1 bonus to Armor Class.`, 'Ring of Warmth');
      expect(wire, line).toMatchObject({ ...want, acBonus: 1 });
      expect(missing, line).toEqual([]);
    }
    // Joined by a PDF to the first paragraph, its bonus is read too.
    expect(parseText('Armor of the Deep — Armor (Scale Mail), Rare (Requires Attunement) While wearing this armor, you have a +1 bonus to Armor Class.', 'Armor of the Deep').wire).toMatchObject({
      typeLineText: 'Armor (Scale Mail), Rare (Requires Attunement)', category: 'armor', acBonus: 1,
    });
    // A name before a parenthesis can't start with a category word: "Armor (Shield), …" is a type line.
    expect(typeLine('_Armor (Shield), Uncommon_').line).toBe('Armor (Shield), Uncommon');
  });

  it('reads every SRD 5.2.1 item with its type line printed as "Name — type line", as the shipped data has it', () => {
    const srd = (JSON.parse(compendiumRaw) as CompendiumEntry[]).filter((e) => e.kind === 'magic-item');
    const forms: Record<string, (name: string, type: string) => string> = {
      'em dash': (name, type) => `_${name} — ${type}_`,
      hyphen: (name, type) => `${name} - ${type}`,
      'em dash, flattened': (name, type) => `${name} — ${type}`,
    };
    for (const [form, line] of Object.entries(forms)) {
      const wrong: string[] = [];
      for (const [i, e] of srd.entries()) {
        const [first, ...rest] = e.text.split('\n');
        const markdown = [line(e.name, first.replace(/^[_*]+|[_*]+$/g, '')), ...rest].join('\n');
        const text = form.endsWith('flattened') ? flatten(markdown) : markdown;
        // Stored as a magic item, so this tests the parser whatever detection (chunk.ts) makes of the line.
        const entry = { id: `lib:srd-dash:${i + 1}`, sourceId: 'srd-dash', sourceName: 'Dash', kind: 'magic-item', name: e.name, text, path: ['Magic Items', e.name] } as CompendiumEntry;
        const c = segment([entry], CTX).candidates[0] as Candidate & { kind: 'magic-item' };
        const { wire, missing } = parseMagicItem(c);
        const data = normalize('magic-item', wire, { blocks: c.blocks, entriesById: new Map([[entry.id, entry]]), origin: 'parser', spellLists: [], missing }).data;
        const shipped = e.data as { category: string; rarity: string; attunement: unknown };
        // The SRD build files magic shields under armor and ammunition under weapons; this app keeps them apart.
        const category = data?.category === 'shield' ? 'armor' : data?.category === 'ammunition' ? 'weapon' : data?.category;
        const ours = { category, rarity: data?.rarity, attunement: data?.attunement };
        const theirs = { category: shipped.category, rarity: shipped.rarity, attunement: shipped.attunement };
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) wrong.push(`${e.name}: ${JSON.stringify(ours)} vs ${JSON.stringify(theirs)}`);
      }
      expect(wrong, form).toEqual([]);
    }
    expect(srd.length).toBe(258);
  });
});
