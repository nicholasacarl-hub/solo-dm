import { describe, expect, it } from 'vitest';
import { EXPECTED_DATA, TEXT, gloamwoodEntries, gloamwoodEntryId } from '@/test/structuredFixtures';
import type { CompendiumEntry, TextSpan } from '@/types';
import { featureText, requestParagraphs, resolveSpan, splitParagraphs, stripRunInLabel } from './paragraphs';

const md = gloamwoodEntries();
const mixed = gloamwoodEntries('gloam', 'mixed');
const byId = new Map(md.map((e) => [e.id, e]));
const mixedById = new Map(mixed.map((e) => [e.id, e]));
const entry = (name: string) => byId.get(gloamwoodEntryId(name)) as CompendiumEntry;
const span = (name: string, from: number, to = from): TextSpan => ({ entryIds: [gloamwoodEntryId(name)], from, to });

describe('splitParagraphs', () => {
  it('splits blank-line blocks and keeps a block’s lines together', () => {
    expect(splitParagraphs('One\nstill one.\n\n\nTwo.\n')).toEqual(['One\nstill one.', 'Two.']);
  });

  it('makes each list item, heading and table body row its own paragraph', () => {
    const text = ['Intro.', '- **AC** 15', '- **HP** 10', '### Actions', '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', 'After.'].join('\n');
    expect(splitParagraphs(text)).toEqual(['Intro.', '- **AC** 15', '- **HP** 10', '### Actions', '| 1 | 2 |', '| 3 | 4 |', 'After.']);
  });

  it('drops table header and separator rows, keeps rows of a table without a header', () => {
    expect(splitParagraphs('| H1 | H2 |\n|:--|--:|\n| a | b |')).toEqual(['| a | b |']);
    expect(splitParagraphs('| a | b |\n| c | d |')).toEqual(['| a | b |', '| c | d |']);
  });

  it('trims paragraphs, drops empty ones and accepts CRLF', () => {
    expect(splitParagraphs('  a  \r\n\r\n \r\n b ')).toEqual(['a', 'b']);
    expect(splitParagraphs('')).toEqual([]);
  });

  it('numbers the fixture book as its spans assume, in both dialects', () => {
    const mothkin = splitParagraphs(entry('Mothkin').text);
    expect(mothkin).toHaveLength(10);
    expect(mothkin[5]).toMatch(/^_\*\*Dusk Sight\.\*\*_/);
    expect(splitParagraphs(entry('Mothkin Lineages').text)).toHaveLength(2);
    for (const e of md) expect(splitParagraphs(mixedById.get(e.id)!.text).length, e.name).toBe(splitParagraphs(e.text).length);
  });
});

describe('requestParagraphs', () => {
  it('keeps the numbering and shows a table’s header above its first body row', () => {
    const text = 'Intro.\n\n| Level | Spells |\n|---|---|\n| 1st | Sleep |\n| 3rd | Darkness |';
    expect(requestParagraphs(text)).toEqual(['Intro.', '| Level | Spells |\n|---|---|\n| 1st | Sleep |', '| 3rd | Darkness |']);
    for (const e of md) expect(requestParagraphs(e.text).length, e.name).toBe(splitParagraphs(e.text).length);
  });
});

describe('resolveSpan', () => {
  it('returns paragraphs from..to of the block joined by blank lines', () => {
    expect(resolveSpan(span('Level 3: Ember Ward', 1, 2), byId)).toBe(TEXT.emberWard.join('\n\n'));
    expect(resolveSpan(span('Mothkin', 6), byId)).toBe(`_**Dusk Sight.**_ ${TEXT.duskSight[0]}`);
  });

  it('joins a multi-entry block before numbering', () => {
    const ids = [gloamwoodEntryId('Thornback'), gloamwoodEntryId('Mossback')];
    expect(resolveSpan({ entryIds: ids, from: 2, to: 3 }, byId)).toBe(`${TEXT.thornback[1]}\n\n${TEXT.mossback[0]}`);
  });

  it('is null out of bounds, for a reversed range or a missing entry', () => {
    expect(resolveSpan(span('Level 3: Ember Ward', 0, 1), byId)).toBeNull();
    expect(resolveSpan(span('Level 3: Ember Ward', 2, 3), byId)).toBeNull();
    expect(resolveSpan(span('Level 3: Ember Ward', 2, 1), byId)).toBeNull();
    expect(resolveSpan({ entryIds: ['lib:gloam:999'], from: 1, to: 1 }, byId)).toBeNull();
    expect(resolveSpan({ entryIds: [], from: 1, to: 1 }, byId)).toBeNull();
  });
});

describe('featureText', () => {
  it('strips a run-in label equal to the name, in every emphasis style and flattened', () => {
    expect(featureText(span('Mothkin', 6), 'Dusk Sight', byId)).toBe(TEXT.duskSight.join('\n\n'));
    expect(featureText(span('Mothkin', 6), 'Dusk Sight', mixedById)).toBe(TEXT.duskSight.join('\n\n'));
    expect(featureText(span('Mothkin', 8, 10), 'Lamp-Drawn', byId)).toBe(TEXT.lampDrawn.join('\n\n'));
    expect(featureText(span('Bramblefolk', 7), 'Thorn Hide', byId)).toBe(TEXT.thornHide.join('\n\n'));
    expect(stripRunInLabel('**Level 3: Frenzy.** You rage.', 'Frenzy')).toBe('You rage.');
    expect(stripRunInLabel('_**Bite**_. Melee.', 'Bite')).toBe('Melee.');
  });

  it('keeps a run-in label that names something else, and text without a label', () => {
    expect(featureText(span('Mothkin', 6), 'Powdered Wings', byId)).toBe(`_**Dusk Sight.**_ ${TEXT.duskSight[0]}`);
    expect(featureText(span('Level 3: Ember Ward', 1, 2), 'Ember Ward', byId)).toBe(TEXT.emberWard.join('\n\n'));
    expect(stripRunInLabel('You have Darkvision. It works.', 'Dusk Sight')).toBe('You have Darkvision. It works.');
  });

  it('drops a leading heading paragraph', () => {
    const entries = new Map([['lib:x:1', { ...entry('Mothkin'), id: 'lib:x:1', text: '### Dusk Sight\n\nYou see.\n\nMore.' }]]);
    expect(featureText({ entryIds: ['lib:x:1'], from: 1, to: 3 }, 'Dusk Sight', entries)).toBe('You see.\n\nMore.');
  });

  it('gives the text EXPECTED_DATA’s spans attach (the descriptions EXPECTED_MERGED copies)', () => {
    const ember = EXPECTED_DATA['Ember Warden'].features;
    expect(featureText(ember[0].text, ember[0].name, byId)).toBe(TEXT.emberWard.join('\n\n'));
    const ferry = EXPECTED_DATA['Ferry Hand'].legacyFeature!;
    expect(featureText(ferry.text, ferry.name, byId)).toBe(TEXT.ferrymansRight.join('\n\n'));
    const lantern = EXPECTED_DATA['Lantern Bearer'];
    expect(featureText(lantern.text, 'Lantern Bearer', byId)).toBe(TEXT.lanternBearer.join('\n\n'));
    expect(featureText({ entryIds: ['lib:gloam:999'], from: 1, to: 1 }, 'x', byId)).toBeNull();
  });
});
