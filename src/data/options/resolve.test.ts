/**
 * Option lookups (spec §5.2): id first; an imported id never binds to an SRD option by name, nor the
 * reverse; same book → SRD → other books. Invented fixture content only.
 */
import { describe, expect, it } from 'vitest';
import { EXPECTED_MERGED, GLOAMWOOD_TITLE, gloamwoodEntryId, importedRef } from '@/test/structuredFixtures';
import type { Character, ClassOption, EquipmentOption, FeatOption, OptionSource, SubclassOption } from '@/types';
import {
  backgroundOptionFor,
  classByName,
  classOptionFor,
  findCatalogOption,
  findEquipment,
  findFeat,
  inventoryFromOption,
  isImportedId,
  optionSourceLabel,
  primaryRuleOf,
  speciesOptionFor,
  subclassByName,
  subclassOptionFor,
  suggestParentClass,
} from './resolve';

const source = (sourceId: string, title: string): OptionSource => ({ sourceId, title, recordId: `rec:${sourceId}:class:x`, format: '2024', adaptations: [] });
const srdFighter = EXPECTED_MERGED.classes.find((c) => c.id === 'srd:class:fighter') as ClassOption;
const bookFighter: ClassOption = { ...srdFighter, id: 'lib:gloam:class:fighter', source: source('gloam', GLOAMWOOD_TITLE), subclasses: [] };
const otherFighter: ClassOption = { ...srdFighter, id: 'lib:other:class:fighter', source: source('other', 'Other Notes'), subclasses: [] };
const classes = [...EXPECTED_MERGED.classes, bookFighter, otherFighter];

describe('isImportedId and optionSourceLabel', () => {
  it('tells library ids apart and labels the source', () => {
    expect(isImportedId('lib:gloam:3')).toBe(true);
    expect(isImportedId('srd:class:fighter')).toBe(false);
    expect(isImportedId(undefined)).toBe(false);
    expect(optionSourceLabel(srdFighter)).toBe('SRD 5.2.1');
    expect(optionSourceLabel(bookFighter)).toBe(GLOAMWOOD_TITLE);
  });
});

describe('classOptionFor', () => {
  it('resolves by id first', () => {
    expect(classOptionFor({ classId: 'lib:gloam:class:fighter', name: 'Fighter' }, classes)).toBe(bookFighter);
    expect(classOptionFor({ classId: 'srd:class:fighter', name: 'Fighter' }, classes)).toBe(srdFighter);
  });

  it('never binds an imported id to the SRD Fighter by name (another device: by ref, else nothing)', () => {
    expect(classOptionFor({ classId: 'lib:elsewhere:class:fighter', name: 'Fighter' }, classes)).toBeUndefined();
    const ref = importedRef({ entryId: 'lib:elsewhere:class:fighter', kind: 'class', entryName: 'Fighter', part: undefined, sourceId: 'elsewhere' });
    expect(classOptionFor({ classId: 'lib:elsewhere:class:fighter', name: 'Fighter', ref }, classes)).toBe(bookFighter);
    const other = importedRef({ ...ref, sourceTitle: 'Other Notes', sourceId: 'gone' });
    expect(classOptionFor({ classId: 'lib:gone:class:fighter', name: 'Fighter', ref: other }, classes)).toBe(otherFighter);
  });

  it("never binds a moved import's id to another book's class of the name, by the ref's book fingerprint", () => {
    // A class of another book: its parts' refs carry that book's fingerprint.
    const otherBookFighter: ClassOption = {
      ...otherFighter,
      features: srdFighter.features.map((f) => ({ ...f, ref: importedRef({ sourceId: 'other', sourceTitle: 'Other Notes', bookFingerprint: 'fp-other' }) })),
    };
    const ref = importedRef({ entryId: 'lib:gone:class:fighter', kind: 'class', entryName: 'Fighter', part: undefined, sourceId: 'gone', sourceTitle: 'Gone', bookFingerprint: 'fp-gone' });
    expect(classOptionFor({ classId: ref.entryId, name: 'Fighter', ref }, [srdFighter, otherBookFighter])).toBeUndefined();
    // The same book moved (its fingerprint) is found whatever its title; a ref without a fingerprint binds by name as before.
    expect(classOptionFor({ classId: ref.entryId, name: 'Fighter', ref: { ...ref, bookFingerprint: 'fp-other' } }, [srdFighter, otherBookFighter])).toBe(otherBookFighter);
    expect(classOptionFor({ classId: ref.entryId, name: 'Fighter', ref: { ...ref, bookFingerprint: undefined } }, [srdFighter, otherBookFighter])).toBe(otherBookFighter);
  });

  it('falls back to the name among SRD options only (old sheets without SRD ids)', () => {
    expect(classOptionFor({ classId: 'class:fighter', name: 'Fighter' }, classes)).toBe(srdFighter);
    expect(classOptionFor({ classId: 'class:wickwright', name: 'Wickwright' }, classes)).toBeUndefined();
  });
});

describe('subclassOptionFor', () => {
  const ember = srdFighter.subclasses.find((s) => s.name === 'Ember Warden');
  const champion = srdFighter.subclasses.find((s) => s.name === 'Champion');

  it('resolves by subclassId, else by a unique name', () => {
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: 'lib:gloam:subclass:ember-warden' }, srdFighter)).toBe(ember);
    expect(subclassOptionFor({ subclass: 'Champion' }, srdFighter)).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Ember Warden' }, srdFighter)).toBe(ember);
    expect(subclassOptionFor({ subclass: 'Nobody' }, srdFighter)).toBeUndefined();
  });

  it('keeps imported and SRD subclasses apart when they share a name', () => {
    const lookalike = { ...ember!, id: 'lib:gloam:subclass:champion', name: 'Champion' };
    const cls = { ...srdFighter, subclasses: [...srdFighter.subclasses, lookalike] };
    expect(subclassOptionFor({ subclass: 'Champion' }, cls)).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Champion', subclassId: 'srd:subclass:champion' }, cls)).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Champion', subclassId: 'lib:moved:subclass:champion' }, cls)).toBe(lookalike);
  });
});

describe('species and background lookups', () => {
  const mothkin = EXPECTED_MERGED.species.find((s) => s.name === 'Mothkin');
  const lamplighter = EXPECTED_MERGED.backgrounds.find((b) => b.name === 'Lamplighter');
  const c = (patch: Partial<Character>) => ({ species: '', background: '', ...patch });

  it('resolves by id, else (imported ids) by ref', () => {
    expect(speciesOptionFor(c({ species: 'Mothkin (Ashwing lineage)', speciesId: 'lib:gloam:species:mothkin' }), EXPECTED_MERGED.species)).toBe(mothkin);
    expect(speciesOptionFor(c({ species: 'Mothkin', speciesId: 'lib:x:species:mothkin' }), EXPECTED_MERGED.species)).toBeUndefined();
    const speciesRef = importedRef({ entryId: 'lib:x:species:mothkin', kind: 'species', entryName: 'Mothkin', part: undefined, sourceId: 'x' });
    expect(speciesOptionFor(c({ species: 'Mothkin', speciesId: 'lib:x:species:mothkin', speciesRef }), EXPECTED_MERGED.species)).toBe(mothkin);
    expect(backgroundOptionFor(c({ background: 'Lamplighter', backgroundId: lamplighter?.id }), EXPECTED_MERGED.backgrounds)).toBe(lamplighter);
  });

  it('never matches an imported option by name for a sheet without ids', () => {
    expect(speciesOptionFor(c({ species: 'Mothkin (Ashwing lineage)' }), EXPECTED_MERGED.species)).toBeUndefined();
    expect(backgroundOptionFor(c({ background: 'Lamplighter' }), EXPECTED_MERGED.backgrounds)).toBeUndefined();
  });
});

describe('findFeat', () => {
  const feat = (id: string, name: string, src?: OptionSource): FeatOption => ({ id, name, category: 'origin', description: '', ...(src ? { source: src } : {}) });
  const srdAlert = feat('srd:feat:alert', 'Alert');
  const bookAlert = feat('lib:gloam:9', 'Alert', source('gloam', GLOAMWOOD_TITLE));
  const otherAlert = feat('lib:other:4', 'Alert', source('other', 'Other Notes'));
  const feats = [otherAlert, srdAlert, bookAlert, feat('srd:feat:magic-initiate', 'Magic Initiate')];

  it('prefers the same book, then the SRD, then other books', () => {
    expect(findFeat(feats, 'Alert', 'gloam')).toBe(bookAlert);
    expect(findFeat(feats, 'Alert')).toBe(srdAlert);
    expect(findFeat([otherAlert], 'Alert', 'gloam')).toBe(otherAlert);
  });

  it('matches the base name before "(…)" after exact names', () => {
    expect(findFeat(feats, 'Magic Initiate (Cleric)')?.id).toBe('srd:feat:magic-initiate');
    expect(findFeat(EXPECTED_MERGED.feats, "Moth's Grace", 'gloam')?.source?.title).toBe(GLOAMWOOD_TITLE);
  });
});

describe('findEquipment', () => {
  const catalog = EXPECTED_MERGED.equipment;

  it('matches package names like the builder always did', () => {
    expect(findEquipment('Daggers', catalog)?.option.name).toBe('Dagger');
    expect(findEquipment('Oil (2 flasks)', catalog)?.option.name).toBe('Oil');
    expect(findEquipment('Hookstaff', catalog, 'gloam')).toMatchObject({ via: 'name', option: { id: 'lib:gloam:item:hookstaff' } });
    expect(findEquipment('Lute', catalog)).toBeNull();
  });

  it('prefers the same book over the SRD and never matches a magic item', () => {
    const bookRope: EquipmentOption = { id: 'lib:gloam:item:rope', name: 'Rope', category: 'gear', source: source('gloam', GLOAMWOOD_TITLE) };
    const withRope = [...catalog, bookRope];
    expect(findEquipment('Rope', withRope, 'gloam')?.option).toBe(bookRope);
    expect(findEquipment('Rope', withRope)?.option.id).toBe('srd:item:rope');
    expect(findEquipment("Warden's Mail", catalog)).toBeNull();
    expect(findCatalogOption("warden's mail", catalog)?.magic?.rarity).toBe('rare');
  });
});

describe('classByName', () => {
  const hero = (classId: string) => ({ classes: [{ classId, name: 'Fighter', level: 3, hitDie: 10, casterType: 'none' }] }) as unknown as Character;
  const older = (o: ClassOption): ClassOption => ({ ...o, source: { ...(o.source as OptionSource), format: '2014' } });

  it("prefers the hero's own class, then the one the player's lists offer (a 2024 book's in place of the SRD's), and reports ties", () => {
    const tie = classByName(classes, 'fighter');
    expect(tie.option).toBe(bookFighter);
    expect(tie.others).toEqual([srdFighter, otherFighter]);
    expect(classByName(classes, 'Fighter', hero('lib:gloam:class:fighter')).option).toBe(bookFighter);
    expect(classByName(classes, 'Fighter', hero('srd:class:fighter')).option).toBe(srdFighter);
    expect(classByName(classes, 'Wickwright')).toEqual({ option: EXPECTED_MERGED.classes[2], others: [] });
    expect(classByName(classes, 'Nobody')).toEqual({ others: [] });
  });

  it("lets a 2024 book's class stand in ahead of an older book's whose title sorts first", () => {
    const ashen: ClassOption = { ...older(bookFighter), id: 'lib:ashen:class:fighter', source: { ...source('ashen', 'The Ashen Folio'), format: '2014' } };
    const list = [...EXPECTED_MERGED.classes, ashen, bookFighter];
    expect(classByName(list, 'Fighter').option).toBe(bookFighter);
  });

  it("keeps the SRD's class beside older-edition books' classes of its name", () => {
    const list = [...EXPECTED_MERGED.classes, older(bookFighter), older(otherFighter)];
    expect(classByName(list, 'Fighter').option).toBe(srdFighter);
  });
});

describe('subclassOptionFor with the subclasses a class shares (merge.ts)', () => {
  const champion = srdFighter.subclasses.find((s) => s.name === 'Champion') as SubclassOption;
  const ember = srdFighter.subclasses.find((s) => s.name === 'Ember Warden') as SubclassOption;
  const bookChampion: SubclassOption = { ...champion, id: 'lib:gloam:subclass:champion', source: source('gloam', GLOAMWOOD_TITLE) };
  const otherChampion: SubclassOption = { ...champion, id: 'lib:other:subclass:champion', source: source('other', 'Other Notes') };
  // A second 2024 book's Fighter with its own Ember Warden, which the SRD Fighter shares.
  const ashenEmber: SubclassOption = { ...ember, id: 'lib:ashen:subclass:ember-warden', source: source('ashen', 'The Ashen Folio') };
  const sharing = { ...srdFighter, sharedSubclasses: [ashenEmber] };

  it('finds an id among those it shares too', () => {
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: ashenEmber.id }, sharing)).toBe(ashenEmber);
    expect(subclassOptionFor({ subclass: 'Champion', subclassId: champion.id }, { ...bookFighter, sharedSubclasses: [champion] })).toBe(champion);
  });

  it("resolves a name to the class's own subclass first, a tie by its own book's (the SRD's under an SRD class), then those it shares", () => {
    // The Gloamwood's Ember Warden is attached to the SRD Fighter itself: the Ashen Folio's never ties with it.
    expect(subclassOptionFor({ subclass: 'Ember Warden' }, sharing)).toBe(ember);
    expect(subclassOptionFor({ subclass: 'Champion' }, { ...bookFighter, subclasses: [bookChampion, otherChampion], sharedSubclasses: [champion] })).toBe(bookChampion);
    expect(subclassOptionFor({ subclass: 'Champion' }, { ...srdFighter, subclasses: [champion, bookChampion] })).toBe(champion);
    expect(subclassOptionFor({ subclass: 'Champion' }, { ...bookFighter, subclasses: [otherChampion], sharedSubclasses: [champion] })).toBe(otherChampion);
    expect(subclassOptionFor({ subclass: 'Champion' }, { ...bookFighter, sharedSubclasses: [champion] })).toBe(champion);
    // Two shared ones of the name and none of the class's own: undecided.
    const second = { ...ashenEmber, id: 'lib:reed:subclass:night-ward', name: 'Night Ward', source: source('reed', 'The Reed Codex') };
    expect(subclassOptionFor({ subclass: 'Night Ward' }, { ...srdFighter, sharedSubclasses: [{ ...second, id: 'lib:x:subclass:night-ward', source: source('x', 'X') }, second] })).toBeUndefined();
  });

  it("gives a moved import's id its ref's book's subclass (shared or not), else only the class's own import of the name", () => {
    // The Ashen Folio's subclass carries no fingerprint of its own here (its parts' refs are another book's).
    const ref = (sourceId: string, sourceTitle: string, bookFingerprint = 'fp-ashen') =>
      importedRef({ entryId: `lib:${sourceId}:subclass:ember-warden`, kind: 'subclass', entryName: 'Ember Warden', sourceId, sourceTitle, bookFingerprint });
    // Re-imported elsewhere: the same title finds the Ashen Folio's, which the SRD Fighter only shares.
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: 'lib:old:subclass:ember-warden', subclassRef: ref('old', 'The Ashen Folio') }, sharing)).toBe(ashenEmber);
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: 'lib:ashen:subclass:gone', subclassRef: ref('ashen', 'Renamed') }, sharing)).toBe(ashenEmber);
    // The hero's own book is switched off: never another book's the class only shares.
    const switchedOff = { ...srdFighter, subclasses: [champion], sharedSubclasses: [ashenEmber] };
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: ember.id, subclassRef: importedRef() }, switchedOff)).toBeUndefined();
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: ember.id }, switchedOff)).toBeUndefined();
    // Without a ref, the class's own one import of the name, as before.
    expect(subclassOptionFor({ subclass: 'Ember Warden', subclassId: 'lib:old:subclass:ember-warden' }, sharing)).toBe(ember);
  });

  describe('by the book fingerprint a ref carries', () => {
    // A subclass of a book: its parts' refs carry the book's fingerprint, as merge.ts gives them.
    const ofBook = (sub: SubclassOption, sourceId: string, title: string, bookFingerprint: string): SubclassOption => ({
      ...sub,
      id: `lib:${sourceId}:subclass:ember-warden`,
      source: source(sourceId, title),
      features: sub.features.map((f) => ({ ...f, ref: { ...(f.ref ?? importedRef()), sourceId, sourceTitle: title, bookFingerprint } })),
    });
    const refOf = (sub: SubclassOption) => importedRef({ entryId: sub.id, kind: 'subclass', entryName: sub.name, sourceId: sub.source!.sourceId, sourceTitle: sub.source!.title, bookFingerprint: sub.features[0].ref!.bookFingerprint });
    const older = ofBook(ember, 't14', 'The Wanderer’s Handbook', 'fp-older');
    const newer = ofBook(ember, 't24', 'The Wanderer’s Handbook', 'fp-newer');

    it("never takes a different book's subclass of the same title once the hero's book is switched off", () => {
      const hero = { subclass: 'Ember Warden', subclassId: older.id, subclassRef: refOf(older) };
      expect(subclassOptionFor(hero, { ...srdFighter, subclasses: [champion, older], sharedSubclasses: [newer] })).toBe(older);
      expect(subclassOptionFor(hero, { ...srdFighter, subclasses: [champion], sharedSubclasses: [newer] })).toBeUndefined();
      // Nor one the class owns: only a moved copy of the same book rebinds by name.
      expect(subclassOptionFor(hero, { ...srdFighter, subclasses: [champion, newer] })).toBeUndefined();
      const moved = ofBook(ember, 'elsewhere', 'Wanderer (scan)', 'fp-older');
      expect(subclassOptionFor(hero, { ...srdFighter, subclasses: [champion, newer, moved] })).toBe(moved);
      // A ref without a fingerprint (an older sheet) binds by name as before.
      expect(subclassOptionFor({ ...hero, subclassRef: { ...refOf(older), bookFingerprint: undefined } }, { ...srdFighter, subclasses: [champion, newer] })).toBe(newer);
    });

    it('finds the same book on another device under another title, a subclass the class only shares too', () => {
      const here = ofBook(ember, 'gloam', GLOAMWOOD_TITLE, 'fp-gloam');
      const there = ofBook(ember, 'g2', 'Gloamwood (PDF)', 'fp-gloam');
      const hero = { subclass: 'Ember Warden', subclassId: here.id, subclassRef: refOf(here) };
      expect(subclassOptionFor(hero, { ...bookFighter, subclasses: [], sharedSubclasses: [there] })).toBe(there);
      // Ahead of another book that has the ref's source id or title.
      const sameTitle = ofBook(ember, 'x', GLOAMWOOD_TITLE, 'fp-x');
      expect(subclassOptionFor(hero, { ...srdFighter, subclasses: [champion, sameTitle], sharedSubclasses: [there] })).toBe(there);
    });
  });

  it('finds a subclass by id under another class (it was shared, and the classes no longer share)', () => {
    const order: SubclassOption = { ...ember, id: 'lib:gloam:subclass:order', name: 'Order of the Lamp' };
    const renamed: ClassOption = { ...bookFighter, name: 'Fighter (Gloamwood)', subclasses: [order] };
    const hero = { subclass: 'Order of the Lamp', subclassId: order.id };
    expect(subclassOptionFor(hero, srdFighter, [srdFighter, renamed])).toBe(order);
    expect(subclassOptionFor({ subclass: 'Champion', subclassId: champion.id }, renamed, [srdFighter, renamed])).toBe(champion);
    // Without the classes: by the class's own lists only.
    expect(subclassOptionFor(hero, srdFighter)).toBeUndefined();
  });
});

describe('subclassByName', () => {
  const champion = srdFighter.subclasses.find((s) => s.name === 'Champion') as SubclassOption;
  const bookChampion: SubclassOption = { ...champion, id: 'lib:gloam:subclass:champion', source: source('gloam', GLOAMWOOD_TITLE) };
  const withBook = (sub: SubclassOption) => ({ ...srdFighter, subclasses: [...srdFighter.subclasses, sub] });

  it("takes a 2024 book's subclass in place of the SRD's of the name, the SRD's beside an older book's", () => {
    expect(subclassByName('champion', withBook(bookChampion))).toBe(bookChampion);
    const older: SubclassOption = { ...bookChampion, source: { ...(bookChampion.source as OptionSource), format: '2014' } };
    expect(subclassByName('Champion', withBook(older))).toBe(champion);
    expect(subclassByName('Champion', srdFighter)).toBe(champion);
    expect(subclassByName('Nobody', withBook(bookChampion))).toBeUndefined();
    expect(subclassByName('Champion', undefined)).toBeUndefined();
  });

  it("gives a hidden SRD subclass's name to the first 2024 book's when other books share it", () => {
    const older: SubclassOption = { ...bookChampion, id: 'lib:ashen:subclass:champion', source: { ...source('ashen', 'The Ashen Folio'), format: '2014' } };
    const second: SubclassOption = { ...bookChampion, id: 'lib:other:subclass:champion', source: source('other', 'Other Notes') };
    expect(subclassByName('Champion', { ...srdFighter, subclasses: [champion, older, bookChampion] })).toBe(bookChampion);
    expect(subclassByName('Champion', { ...srdFighter, subclasses: [champion, bookChampion, second] })).toBe(bookChampion);
  });

  it("leaves two books' subclasses of one name undecided, as the no-id rule does", () => {
    const second: SubclassOption = { ...bookChampion, id: 'lib:other:subclass:champion', source: source('other', 'Other Notes') };
    expect(subclassByName('Champion', { ...srdFighter, subclasses: [bookChampion, second] })).toBeUndefined();
  });

  it('looks among those the class shares too: the SRD’s or its 2024 stand-in first, else the class’s own', () => {
    const ember = srdFighter.subclasses.find((s) => s.name === 'Ember Warden') as SubclassOption;
    const ashenEmber: SubclassOption = { ...ember, id: 'lib:ashen:subclass:ember-warden', source: source('ashen', 'The Ashen Folio') };
    const ashenChampion: SubclassOption = { ...champion, id: 'lib:ashen:subclass:champion', source: source('ashen', 'The Ashen Folio') };
    const older: SubclassOption = { ...bookChampion, source: { ...(bookChampion.source as OptionSource), format: '2014' } };
    // Only shared: found. Tied with one attached to the class itself: the class's own.
    expect(subclassByName('Champion', { ...bookFighter, sharedSubclasses: [champion] })).toBe(champion);
    expect(subclassByName('Ember Warden', { ...srdFighter, sharedSubclasses: [ashenEmber] })).toBe(ember);
    expect(subclassByName('Ember Warden', { ...bookFighter, subclasses: [ashenEmber], sharedSubclasses: [...srdFighter.subclasses] })).toBe(ashenEmber);
    // The SRD's hidden by a shared 2024 one: that one, though an older book's is attached to the class itself.
    expect(subclassByName('Champion', { ...srdFighter, subclasses: [champion, older], sharedSubclasses: [ashenChampion] })).toBe(ashenChampion);
    // Under a book's class, the SRD's it shares beside an older book's attached to it.
    expect(subclassByName('Champion', { ...bookFighter, subclasses: [older], sharedSubclasses: [champion] })).toBe(champion);
  });
});

describe('primaryRuleOf', () => {
  it('reads the explicit rule, else the SRD Fighter is "any" and everyone else "all"', () => {
    expect(primaryRuleOf(srdFighter)).toBe('any');
    expect(primaryRuleOf({ id: 'lib:gloam:class:fighter' })).toBe('all');
    expect(primaryRuleOf({ id: 'lib:gloam:class:fighter', primaryAbilityRule: 'any' })).toBe('any');
    expect(primaryRuleOf({ id: 'srd:class:fighter', primaryAbilityRule: 'all' })).toBe('all');
  });
});

describe('suggestParentClass', () => {
  const list = [
    { id: 'srd:class:fighter', name: 'Fighter' },
    { id: 'srd:class:cleric', name: 'Cleric' },
    { id: 'lib:gloam:class:wickwright', name: 'Wickwright', sourceId: 'gloam' },
    { id: 'lib:a:class:lamplord', name: 'Lamplord', sourceId: 'a' },
    { id: 'lib:b:class:lamplord', name: 'Lamplord', sourceId: 'b' },
    { id: 'lib:c:class:tidecaller', name: 'Tidecaller', sourceId: 'c' },
  ];

  it('gives each reason', () => {
    expect(suggestParentClass('Wickwright', 'gloam', list)).toMatchObject({ id: 'lib:gloam:class:wickwright', reason: 'same-book' });
    expect(suggestParentClass('fighter', 'gloam', list)).toMatchObject({ id: 'srd:class:fighter', reason: 'srd' });
    expect(suggestParentClass('Tidecaller', 'gloam', list)).toMatchObject({ id: 'lib:c:class:tidecaller', reason: 'other-book' });
    const ambiguous = suggestParentClass('Lamplord', 'gloam', list);
    expect(ambiguous).toEqual({ reason: 'ambiguous', candidates: [{ id: 'lib:a:class:lamplord', name: 'Lamplord' }, { id: 'lib:b:class:lamplord', name: 'Lamplord' }] });
    expect(suggestParentClass('Nobody', 'gloam', list)).toEqual({ reason: 'missing', candidates: [] });
    expect(suggestParentClass('', 'gloam', list)).toEqual({ reason: 'missing', candidates: [] });
  });
});

describe('inventoryFromOption', () => {
  const byName = (name: string) => EXPECTED_MERGED.equipment.find((e) => e.name === name) as EquipmentOption;

  it("copies Warden's Mail's numbers and a ref, with an app-written description (no book text)", () => {
    const item = inventoryFromOption(byName("Warden's Mail"), 1, EXPECTED_MERGED.equipment);
    expect(item).toEqual({
      name: "Warden's Mail",
      quantity: 1,
      category: 'armor',
      compendiumId: gloamwoodEntryId("Warden's Mail"),
      weight: 55,
      description: 'Rare armor (Chain Mail) · +1 AC',
      armor: { kind: 'armor', armorType: 'heavy', baseAc: 16, dexCap: 0, strength: 13, stealthDisadvantage: true },
      magic: true,
      bonuses: { ac: 1 },
      requiresAttunement: false,
      ref: expect.objectContaining({ kind: 'magic-item', entryName: "Warden's Mail", textCopied: false, textHash: '' }),
    });
  });

  it('marks attunement for the Mothsilk Cloak and copies its bonuses', () => {
    const item = inventoryFromOption(byName('Mothsilk Cloak'), 1);
    expect(item).toMatchObject({ category: 'gear', magic: true, requiresAttunement: true, bonuses: { ac: 1, savingThrows: 1 } });
    expect(item.description).toBe('Uncommon magic item, requires attunement · +1 AC and saving throws');
    expect(item.armor).toBeUndefined();
  });

  it('gives an imported weapon a numbers-only description and an SRD item its own', () => {
    expect(inventoryFromOption(byName('Hookstaff'), 1).description).toBe('Martial melee weapon · 1d8 bludgeoning · Reach, Two-Handed · mastery Topple');
    expect(inventoryFromOption(byName('Hookstaff'), 1).ref).toMatchObject({ kind: 'item', textCopied: false });
    const rope = inventoryFromOption(byName('Rope'), 1);
    expect(rope.ref).toBeUndefined();
    expect(rope.description).toBe(byName('Rope').description);
  });
});
