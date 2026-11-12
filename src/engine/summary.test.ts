import { describe, expect, it } from 'vitest';
import type { Character, Feature } from '@/types';
import { importedPlaceholder, redactImported, wrapImported } from '@/lib/importedContent';
import { sampleCharacter } from '@/test/fixtures';
import { GLOAMWOOD_MARKERS, GLOAMWOOD_TITLE, importedRef, TEXT } from '@/test/structuredFixtures';
import { applyDamage } from './character';
import { characterSheetText, characterStatusLine, SHEET_TEXT_MAX } from './summary';
import { beginTransformation, endTransformation } from './transform';

const mira = (overrides: Partial<Character> = {}) => sampleCharacter(overrides);

describe('characterStatusLine', () => {
  it('summarizes the sample character on one line', () => {
    expect(characterStatusLine(mira())).toBe(
      'Mira Voss (Wizard 3) · HP 12/17 · AC 12 · Slots 1st 3/4, 2nd 2/2 · Hit Dice 2/3 d6 · Heroic Inspiration',
    );
  });

  it('shows temp HP, conditions, exhaustion, speed changes and concentration', () => {
    const c = mira({
      hp: { max: 17, current: 12, temp: 5 },
      conditions: [{ id: 'poisoned' }, { id: 'Hexed' }],
      exhaustion: 1,
      heroicInspiration: false,
      spellcasting: { ...mira().spellcasting!, concentratingOn: 'Detect Magic' },
    });
    expect(characterStatusLine(c)).toBe(
      'Mira Voss (Wizard 3) · HP 12/17 (+5 temp) · AC 12 · Speed 25 ft · Slots 1st 3/4, 2nd 2/2 · Hit Dice 2/3 d6 · Conditions: Poisoned, Hexed · Exhaustion 1 · Concentrating: Detect Magic',
    );
  });

  it('flags dying, stable and dead characters', () => {
    const down = applyDamage(mira(), 12).character;
    expect(characterStatusLine(down)).toContain('HP 0/17 · Dying (death saves: 0 successes, 0 failures)');
    expect(characterStatusLine({ ...down, deathSaves: { successes: 0, failures: 0, stable: true, dead: false } })).toContain('Stable at 0 HP');
    expect(characterStatusLine({ ...down, deathSaves: { successes: 0, failures: 3, stable: false, dead: true } })).toContain('DEAD');
  });

  it('shows Pact Magic and multiclass levels', () => {
    const c = mira({
      classes: [...mira().classes, { classId: 'srd:class:warlock', name: 'Warlock', level: 2, hitDie: 8, casterType: 'pact', spellcastingAbility: 'cha' }],
      spellcasting: { ...mira().spellcasting!, pact: { slotLevel: 1, slots: { max: 2, used: 1 } } },
    });
    expect(characterStatusLine(c)).toContain('(Wizard 3 / Warlock 2)');
    expect(characterStatusLine(c)).toContain('Pact 1/2 (1st)');
  });
});

describe('characterSheetText', () => {
  const sheet = characterSheetText(mira());

  it('is a markdown sheet with the numbers a DM needs', () => {
    expect(sheet.startsWith('## Mira Voss — Wizard 3 (Evoker)\n')).toBe(true);
    expect(sheet).toContain('900 XP (1,800 to level 4)');
    expect(sheet).toContain('**AC** 12 (10 + DEX)');
    expect(sheet).toContain('**Passive Perception** 13');
    expect(sheet).toContain('INT +5 (prof)');
    expect(sheet).toContain('Arcana +5 (prof)');
    expect(sheet).toContain('Stealth +2');
    expect(sheet).toContain('- **Dagger** +4 to hit, 1d4+2 piercing');
    expect(sheet).toContain('- **Fire Bolt** +5 to hit, 1d10 fire');
    expect(sheet).toContain('INT: save DC 13, spell attack +5');
    expect(sheet).toContain('- Cantrips: Fire Bolt, Light, Mage Hand, Prestidigitation (High Elf)');
    expect(sheet).toContain('Sleep (C, not prepared)');
    expect(sheet).toContain('**Magic Initiate (Wizard)** (Sage (Origin feat); 0/1 per long rest)');
    expect(sheet).toContain('Potion of Healing ×2 (magic)');
    expect(sheet).toContain('**Coins:** 23 gp, 30 sp, 14 cp (26.14 gp total)');
    expect(sheet).toContain('- Bonds: My missing mentor kept the lighthouse.');
  });

  it('is deterministic and compact', () => {
    expect(characterSheetText(mira())).toBe(sheet);
    expect(sheet).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const approxTokens = sheet.length / 4;
    expect(approxTokens).toBeGreaterThan(300);
    expect(approxTokens).toBeLessThan(900);
  });

  it('shows scaled cantrip dice, Eldritch Blast beams and a Champion’s critical range', () => {
    const blast = { id: 'eb', name: 'Eldritch Blast', ability: 'spell' as const, proficient: true, damage: '1d10', damageType: 'force', addAbilityToDamage: false, notes: 'Cantrip' };
    const wizard5 = mira({ classes: [{ ...mira().classes[0], level: 5 }], attacks: [...mira().attacks, blast] });
    const text = characterSheetText(wizard5);
    expect(text).toContain('- **Fire Bolt** +6 to hit, 2d10 fire · 120 ft.');
    expect(text).toContain('- **Eldritch Blast** +6 to hit, 1d10 force · Cantrip · 2 beams at this level (one attack roll each)');
    expect(text).not.toContain('Critical Hit on');
    const champion = mira({ classes: [{ classId: 'srd:class:fighter', name: 'Fighter', level: 3, hitDie: 10, casterType: 'none', subclass: 'Champion' }] });
    const fighterSheet = characterSheetText(champion);
    expect(fighterSheet).toMatch(/- \*\*Dagger\*\* .* · Critical Hit on 19–20/);
    expect(fighterSheet).not.toMatch(/Fire Bolt.*Critical Hit/);
  });

  // An invented backstory of three paragraphs (about 800 characters) and long ideals: the old sheet kept the first
  // 500 and 200 characters, so the hero's goal and his weapon never reached the DM.
  const BACKSTORY = [
    'Kestrel Vane grew up on the salt flats east of Harrowmere, where the caravans stop only to water their oxen. His mother traded rope and lamp oil; his father was a story she told on cold nights.',
    "At twelve he found a dragon's shed scale half buried in the flats, warm as a hearthstone in his hand. He swore an oath over it: one day he will become a dragon himself, scales and wings and all.",
    'He fights with twin hooked blades joined by a length of black chain, a gift from the smith who taught him to throw them. He keeps the scale on a cord around his neck.',
  ];
  const IDEALS =
    'Transformation. Anything worth having is worth changing yourself to reach, and a person who stays the same out of fear has already lost. Freedom. No chain holds me that I did not forge myself. Loyalty to the few who stayed.';

  it("keeps the player's long text whole, paragraphs included, and handles a bare character", () => {
    const sheet = characterSheetText(mira({ personality: { ...mira().personality, backstory: BACKSTORY.join('\n\n'), ideals: IDEALS } }));
    expect(IDEALS.length).toBeGreaterThan(200);
    expect(sheet).toContain(`- Ideals: ${IDEALS}\n`);
    // Continuation lines are indented under their list item; the blank line between paragraphs stays blank.
    expect(sheet).toContain(`- Backstory: ${BACKSTORY.join('\n\n  ')}`);
    expect(sheet).toContain('a length of black chain');
    expect(sheet).not.toContain('…');
    expect(sheet).not.toContain('too long for this sheet');
    const bare = characterSheetText(mira({ spellcasting: undefined, attacks: [], features: [], inventory: [], personality: {} }));
    expect(bare).not.toContain('### Spellcasting');
    expect(bare).not.toContain('### Attacks');
    expect(bare).toContain('### Equipment\nnothing');
  });

  it('keeps lines, lists and indents, drops extra blank lines and spaces, and formats a one-line text as before', () => {
    const backstory = 'Born at sea.\r\n\r\n\r\n- Lost an eye to a squid\n  - Kept the squid\nNow:   a   lighthouse   keeper.   ';
    expect(characterSheetText(mira({ personality: { backstory } }))).toContain(
      '- Backstory: Born at sea.\n\n  - Lost an eye to a squid\n    - Kept the squid\n  Now: a lighthouse keeper.',
    );
    expect(characterSheetText(mira({ personality: { bonds: '  My   missing mentor\tkept the lighthouse. ' } }))).toContain(
      '- Bonds: My missing mentor kept the lighthouse.',
    );
  });

  it('cuts a field only past SHEET_TEXT_MAX, at a paragraph end, and says how much it left out', () => {
    expect(SHEET_TEXT_MAX).toBe(20_000);
    const para = `${'word '.repeat(199)}end.`; // 999 characters
    const long = Array.from({ length: 30 }, () => para).join('\n\n'); // 30,028 characters
    const kept = Array.from({ length: 19 }, () => para).join('\n\n  '); // the 19 paragraphs that end before 20,000
    expect(characterSheetText(mira({ personality: { backstory: long } }))).toContain(
      `- Backstory: ${kept} [11,011 more characters are too long for this sheet; ask the player if you need the rest]`,
    );
  });

  it('never cuts between the halves of an emoji in a run with no spaces', () => {
    const sheet = characterSheetText(mira({ personality: { backstory: `a${'🐉'.repeat(12_000)}` } }));
    const kept = sheet.split('- Backstory: ')[1].split(' [')[0];
    expect(kept.length).toBe(SHEET_TEXT_MAX - 1);
    expect(kept).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(sheet).toContain(' [4,002 more characters are too long for this sheet;');
  });

  it('stays linear on a pathological paste', () => {
    const paste = `${' '.repeat(200_000)}x\n${'y '.repeat(200_000)}\n${'\n'.repeat(100_000)}z${'\t '.repeat(100_000)}`;
    const start = performance.now();
    const sheet = characterSheetText(mira({ personality: { backstory: paste } }));
    expect(performance.now() - start).toBeLessThan(1000);
    expect(sheet).toMatch(/- Backstory: x\n {2}y y y .* \[\d{3},\d{3} more characters are too long for this sheet/);
  });

  it("shows a feature's rules text whole, its paragraphs and table kept", () => {
    const text = [
      'You can channel the storm in your blood. As a Bonus Action, you surround yourself with crackling wind until the start of your next turn; while it lasts, ranged attack rolls against you have Disadvantage and you can fly 10 feet as part of any movement.',
      'You can use this feature a number of times equal to your Charisma modifier (minimum of once), and you regain all expended uses when you finish a Long Rest. At level 6, the wind also deals 1d6 Thunder damage to a creature that hits you with a melee attack.',
      '| Level | Fly |\n|---|---|\n| 3 | 10 ft. |\n| 6 | 20 ft. |',
    ];
    const ward: Feature = { id: 'f-storm', name: 'Storm Ward', source: 'class', sourceName: 'Sorcerer 3', description: text.join('\n\n') };
    expect(characterSheetText(mira({ features: [ward] }))).toContain(
      `- **Storm Ward** (Sorcerer 3): ${text[0]}\n\n  ${text[1]}\n\n  | Level | Fly |\n  |---|---|\n  | 3 | 10 ft. |\n  | 6 | 20 ft. |`,
    );
  });
});

describe('book text copied onto the sheet (structured imports, spec §7.2)', () => {
  const emberWard: Feature = {
    id: 'f-ember',
    name: 'Ember Ward',
    source: 'subclass',
    sourceName: 'Ember Warden 3',
    description: TEXT.emberWard.join('\n\n'),
    ref: importedRef(),
  };

  it("leaves an SRD-only character's sheet byte-identical (frozen prompts are unaffected)", async () => {
    // Generated from the summary module as it was before structured imports.
    await expect(`${characterSheetText(mira())}\n`).toMatchFileSnapshot('./__snapshots__/sheet-srd-character.md');
  });

  it('wraps the whole copied text as one passage, so redaction removes all of it', () => {
    const sheet = characterSheetText(mira({ features: [emberWard] }));
    expect(sheet).toContain(
      `- **Ember Ward** (Ember Warden 3): <imported-content source="${GLOAMWOOD_TITLE}">\n  ${TEXT.emberWard.join('\n\n  ')}\n  </imported-content>`,
    );
    // The last sentence, which the old 200-character cut never sent, reaches the DM inside the wrapper.
    expect(sheet).toContain(GLOAMWOOD_MARKERS[0]);
    const redacted = redactImported(sheet);
    expect(redacted).toContain(`- **Ember Ward** (Ember Warden 3): ${importedPlaceholder(GLOAMWOOD_TITLE)}`);
    for (const marker of GLOAMWOOD_MARKERS) expect(redacted).not.toContain(marker);
    expect(redacted).not.toContain('banked heat');
  });

  it('cuts copied text past SHEET_TEXT_MAX inside its wrapper, with the note outside, so redaction still removes all of it', () => {
    const para = `${'banked heat '.repeat(83)}${GLOAMWOOD_MARKERS[0]}`; // about 1,040 characters
    const huge = { ...emberWard, description: Array.from({ length: 25 }, () => para).join('\n\n') };
    const sheet = characterSheetText(mira({ features: [huge] }));
    expect(sheet).toMatch(/\n {2}<\/imported-content> \[\d{1},\d{3} more characters are too long for this sheet; ask the player if you need the rest\]/);
    const redacted = redactImported(sheet);
    expect(redacted).toMatch(/- \*\*Ember Ward\*\* \(Ember Warden 3\): \[Text from the player's imported book "[^"]+" was left out of this copy\.\] \[\d,\d{3} more characters/);
    expect(redacted).not.toContain(GLOAMWOOD_MARKERS[0]);
    expect(redacted).not.toContain('banked heat');
  });

  it('says how to get the text back when a save left it out', () => {
    const left = { ...emberWard, description: importedPlaceholder(GLOAMWOOD_TITLE) };
    const line = `- **Ember Ward** (Ember Warden 3): (text from the player's book “${GLOAMWOOD_TITLE}” isn't on this device — call get_character_sheet after they import it, or rule from the name)`;
    expect(characterSheetText(mira({ features: [left] }))).toContain(line);
    expect(characterSheetText(mira({ features: [{ ...left, ref: { ...importedRef(), redacted: true } }] }))).toContain(line);
  });

  it('P3: shows a ruling the DM wrote over a pulled placeholder, though the ref still says redacted', () => {
    const ruling = 'DM ruling: once per turn, add 1d4 fire damage.';
    const rewritten = { ...emberWard, description: ruling, ref: { ...importedRef(), redacted: true as const } };
    const sheet = characterSheetText(mira({ features: [rewritten] }));
    expect(sheet).toContain(`- **Ember Ward** (Ember Warden 3): ${wrapImported(GLOAMWOOD_TITLE, ruling).replace(/\n/g, '\n  ')}`);
    expect(sheet).not.toContain("isn't on this device");
  });

  it("doesn't wrap a ref'd feature whose description is the app's own", () => {
    const linked = { ...emberWard, description: 'Ember Ward, from your book.', ref: importedRef({ textCopied: false }) };
    expect(characterSheetText(mira({ features: [linked] }))).toContain('- **Ember Ward** (Ember Warden 3): Ember Ward, from your book.');
  });

  it('lists older-edition notes only when the character has some', () => {
    expect(characterSheetText(mira())).not.toContain('Older-edition');
    const notes = ['Older edition: Ferry Hand doesn\'t grant an Origin feat, so you choose one.'];
    const sheet = characterSheetText(mira({ adaptationNotes: notes }));
    expect(sheet).toContain(`### Older-edition options (app notes)\n- ${notes[0]}\n\n### Equipment`);
  });
});

describe('transformations in the DM-facing text', () => {
  const opts = { session: 2, now: 1, newId: (() => { let n = 0; return () => `t-${++n}`; })() };
  const turned = beginTransformation(
    mira(),
    {
      name: 'Vampirism',
      summary: 'Strength in darkness, a thirst for blood, and the sun as an enemy.',
      origin: 'imposed',
      stage: 'Fledgling',
      howItEnds: 'Slay the vampire lord who sired you.',
      features: [{ name: 'Vampiric Bite', description: 'Bite and drink.', uses: { max: 1, recharge: 'long' } }],
    },
    opts,
  ).character;

  it('lists active transformations on the status line', () => {
    expect(characterStatusLine(turned)).toMatch(/ · Transformations: Vampirism \(Fledgling\)$/);
    expect(characterStatusLine(mira())).not.toContain('Transformations');
  });

  it('gives the sheet a Transformations section and marks transformation features', () => {
    const sheet = characterSheetText(turned);
    expect(sheet).toContain('### Transformations\n- **Vampirism** (Fledgling; imposed; since session 2): Strength in darkness, a thirst for blood, and the sun as an enemy. How it could end: Slay the vampire lord who sired you.');
    expect(sheet).toContain('- **Vampiric Bite** (transformation: Vampirism; 1/1 per long rest): Bite and drink.');
    const cured = characterSheetText(endTransformation(turned, 'Vampirism', { ...opts, session: 4 }).character);
    expect(cured).toContain('### Transformations\n- Ended: Vampirism (ended in session 4)');
    expect(cured).not.toContain('Vampiric Bite');
    expect(characterSheetText(mira())).not.toContain('### Transformations');
  });

  it("shows the DM's own summary and way back whole, at their tool's longest (400 and 300 characters)", () => {
    const summary = `${'You crave the dark and the sun burns you. '.repeat(9)}Mirrors no longer show you.`.slice(0, 400);
    const howItEnds = `${'Find the sire in the drowned chapel and drink from the font. '.repeat(5)}`.slice(0, 300).trim();
    const long = { ...turned, transformations: turned.transformations?.map((t) => ({ ...t, summary, howItEnds })) };
    expect(characterSheetText(long)).toContain(`(Fledgling; imposed; since session 2): ${summary.trim()} How it could end: ${howItEnds}`);
  });
});
