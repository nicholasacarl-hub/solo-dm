import { describe, expect, it } from 'vitest';
import {
  AREA_SHAPES,
  AREA_TERRAIN,
  COMPASS_DIRECTIONS,
  CREATURE_SIZES,
  MOVE_KINDS,
  TERRAIN_KINDS,
} from '@/types';
import { DM_TOOLS, READ_ONLY_TOOLS, SCHEMA_VOCABULARIES, TOOL_DESCRIPTIONS, TOOL_ORDER, TOOL_SCHEMAS, toolActivity } from './definitions';

const MAP_TOOLS = ['move_tokens', 'update_map', 'resolve_area', 'check_map'] as const;

describe('the static tools array (append-only: it never changes during a session)', () => {
  it('sends every schema, and only those, in TOOL_ORDER', () => {
    // A tool missing from TOOL_ORDER would silently never be sent.
    expect([...TOOL_ORDER].sort()).toEqual(Object.keys(TOOL_SCHEMAS).sort());
    expect(new Set(TOOL_ORDER).size).toBe(TOOL_ORDER.length);
    expect(DM_TOOLS.map((t) => t.name)).toEqual(TOOL_ORDER);
    expect(TOOL_ORDER).toHaveLength(25);
  });

  it('puts the four map tools right after end_combat', () => {
    const at = TOOL_ORDER.indexOf('end_combat');
    expect(TOOL_ORDER.slice(at + 1, at + 5)).toEqual([...MAP_TOOLS]);
  });

  it('marks check_map read-only (regenerate stays allowed after it) and the map writers not', () => {
    expect(READ_ONLY_TOOLS.has('check_map')).toBe(true);
    for (const name of ['move_tokens', 'update_map', 'resolve_area', 'start_combat', 'update_combat', 'roll_dice']) {
      expect(READ_ONLY_TOOLS.has(name), name).toBe(false);
    }
  });

  it('keeps each schema under its cap and every description substantial', () => {
    // 8,000 characters each; update_character alone may reach 8,750: it gained hp_max, hp_max_end, hp.drain and
    // initiative_change, then ac_spells_add and ac_spells_end (measured at 8,656; their guidance lives in its
    // description, not in the schema).
    const caps: Record<string, number> = { update_character: 8_750 };
    for (const tool of DM_TOOLS) {
      expect(JSON.stringify(tool.input_schema).length, tool.name).toBeLessThan(caps[tool.name] ?? 8_000);
      expect(tool.description?.length, tool.name).toBeGreaterThan(80);
    }
  });

  it('uses schema vocabularies that match the shared type lists', () => {
    expect([...SCHEMA_VOCABULARIES.sizes]).toEqual([...CREATURE_SIZES]);
    expect([...SCHEMA_VOCABULARIES.terrainKinds]).toEqual([...TERRAIN_KINDS]);
    expect([...SCHEMA_VOCABULARIES.areaShapes]).toEqual([...AREA_SHAPES]);
    expect([...SCHEMA_VOCABULARIES.areaTerrain]).toEqual([...AREA_TERRAIN]);
    expect([...SCHEMA_VOCABULARIES.moveKinds]).toEqual([...MOVE_KINDS]);
    expect([...SCHEMA_VOCABULARIES.directions]).toEqual([...COMPASS_DIRECTIONS]);
    expect([...SCHEMA_VOCABULARIES.doorStates]).toEqual(['open', 'closed', 'locked']);
    expect([...SCHEMA_VOCABULARIES.moveModes]).toEqual(['walk', 'fly']);
  });
});

describe('the Hit Point maximum fields explain themselves to sessions whose frozen prompt never mentions them', () => {
  it('update_character and take_rest say how the maximum changes and ends', () => {
    for (const phrase of [
      'hp_max',
      'hp.drain',
      'hp_max_end',
      'never temporary HP',
      'initiative_change',
      'never the total',
      'a maximum of 0 kills',
      // srd:spell:greater-restoration: "Any reduction to the target's Hit Point maximum".
      'Greater Restoration ends every reduction in effect',
      'in one call reductions end before raises',
      // srd:spell:aura-of-life: "your Hit Point maximums can't be reduced".
      "inside Aura of Life the maximum can't be reduced",
    ]) {
      expect(TOOL_DESCRIPTIONS.update_character).toContain(phrase);
    }
    expect(TOOL_DESCRIPTIONS.take_rest).toContain('a reduced HP maximum returns to normal');
    // srd:spell:aid ("Duration: 8 hours") ends before srd:rule:long-rest finishes.
    expect(TOOL_DESCRIPTIONS.take_rest).toContain("raises that end at a Long Rest end first, since Aid's 8 hours are over before the rest finishes");
  });
});

describe('spell effects explain themselves to sessions whose frozen prompt never mentions them (the third change)', () => {
  type FieldSchema = { description?: string; enum?: string[]; maxItems?: number; anyOf?: unknown[]; items?: FieldSchema };
  type ToolSchema = { properties: Record<string, FieldSchema & { items?: { properties?: Record<string, FieldSchema> } }> };
  const schemaOf = (name: string) => DM_TOOLS.find((t) => t.name === name)?.input_schema as unknown as ToolSchema;

  it("update_combat says how NPC Concentration works, what the app rolls and ends, and what it doesn't (srd:rule:concentration)", () => {
    for (const phrase of [
      "`concentrate` records an NPC's or monster's Concentration on `spell` (a spell or another Concentration effect) on the caster's turn, before next_turn",
      'spell null ends it, and the same spell again is a recast',
      '1 minute = 10 rounds',
      "one round more for a spell cast between the caster's turns",
      'rounds for a longer "(level N version)"',
      'rolls a plain Constitution save from its stat block when it takes damage',
      'one damage call per hit',
      "Magic Resistance doesn't apply",
      'a creature with Legendary Resistance decides first',
      'without saves in its stat block you roll it',
      // D13: srd:spell:bless adds 1d4 to a save, srd:spell:bane takes 1d4 off: a kept save that should have failed is
      // put right with spell null, a failed one with the spell and its rounds again.
      "a bonus or penalty the app can't see (Bless, Bane) is put right with concentrate: the spell and its rounds again, or spell null",
      'ends the spell at 0 HP, on an Incapacitating condition, a failed save or when its time is up — not on defeat or remove',
      'naming what to end with it (areas, conditions)',
      "Don't record a spell a stat block casts without Concentration.",
      "For the hero's own spell, concentrate only sets `rounds` (update_character starts and ends it).",
    ]) {
      expect(TOOL_DESCRIPTIONS.update_combat, phrase).toContain(phrase);
    }
    expect(TOOL_DESCRIPTIONS.update_combat).not.toContain('is put right with concentrate and rounds');
    const update = schemaOf('update_combat').properties;
    expect(update.action.enum).toContain('concentrate');
    expect(update.spell.description).toBe('For action "concentrate": the spell or effect it concentrates on, or null when that ends.');
    expect(update.rounds.description).toBe('For action "concentrate": rounds left (1 minute = 10); default: the spell\'s duration.');
  });

  it('update_character says how AC spells are recorded and ended (srd:spell:mage-armor, srd:spell:shield-of-faith, srd:spell:shield)', () => {
    for (const phrase of [
      'ac_spells_add records Mage Armor (base AC 13 + Dexterity while no armor is worn, until a Long Rest)',
      "or Shield of Faith (+2, ending with the hero's Concentration on it) and ac_spells_end ends one; the app applies and removes the AC",
      "fold Shield's +5 into the dc of attacks on the hero",
      'for a lasting one (Haste, Barkskin) set armor_class, and set it back when it ends',
    ]) {
      expect(TOOL_DESCRIPTIONS.update_character, phrase).toContain(phrase);
    }
    const sheet = schemaOf('update_character').properties;
    expect(sheet.armor_class.description).toBe("AC set by hand (a homebrew effect, armor the app can't identify); not for Mage Armor or Shield of Faith (ac_spells_add).");
    expect(sheet.concentration.description).toBe('Spell the hero starts (or recasts) concentrating on, or null when it ends; in a fight the app counts its duration.');
    for (const key of ['ac_spells_add', 'ac_spells_end']) {
      expect(sheet[key].description, key).toBeUndefined();
      expect(sheet[key].maxItems, key).toBe(2);
    }
  });

  it('teaches a condition\'s source to name the spell, so the app can name the conditions a spell may hold', () => {
    const source = 'What caused it: "Giant spider venom", a spell by its name ("Hold Person").';
    expect(schemaOf('update_character').properties.conditions_add.items?.properties?.source.description).toBe(source);
    expect(schemaOf('update_combat').properties.conditions_add.items?.properties?.source.description).toBe(source);
  });
});

describe('descriptions stand alone for sessions whose frozen prompt predates the battle map (D55)', () => {
  it("tells the DM the app asks the player about the hero's Opportunity Attack", () => {
    expect(TOOL_DESCRIPTIONS.move_tokens).toContain('the app asks the player there and then and tells you the answer');
    expect(TOOL_DESCRIPTIONS.move_tokens).toContain("don't ask again");
    expect(TOOL_DESCRIPTIONS.move_tokens).toContain('call update_combat next_turn first');
  });

  it('explains the grid, the area rules and the reach check where each tool is used', () => {
    expect(TOOL_DESCRIPTIONS.start_combat).toContain('A1 is the top-left');
    expect(TOOL_DESCRIPTIONS.start_combat).toContain('Map input is checked before anyone rolls.');
    expect(TOOL_DESCRIPTIONS.resolve_area).toContain('Never decide who is in an area by eye.');
    expect(TOOL_DESCRIPTIONS.check_map).toContain('Never estimate distances, reach or cover yourself.');
    expect(TOOL_DESCRIPTIONS.roll_dice).toContain("warns when a melee attacker isn't in reach");
    expect(TOOL_DESCRIPTIONS.update_combat).toContain('`reveal` a hidden creature');
    expect(TOOL_DESCRIPTIONS.update_map).toContain("`create` is refused when the campaign's battle maps are Off");
  });

  it('D8: promises from check_map `from` alone only what it returns (spec §4.10), and points to `to` for sight and cover', () => {
    const schema = DM_TOOLS.find((t) => t.name === 'check_map')?.input_schema as { properties: Record<string, { description?: string }> };
    const from = schema.properties.from.description ?? '';
    expect(from).toBe(
      'A creature or square to measure from. Alone: the distance to everyone and, for a creature, the best cover it can reach this turn (add `to` for line of sight, cover and reach).',
    );
    expect(schema.properties.to.description).toBe('Creatures or squares to measure to: distance, line of sight, cover and reach, both ways.');
  });
});

describe('the one structured-imports change to DM_TOOLS (spec §6.5)', () => {
  type ObjectSchema = { properties: Record<string, { description?: string } & Partial<ObjectSchema> & { items?: ObjectSchema }>; required?: string[] };
  const schemaOf = (name: string) => DM_TOOLS.find((t) => t.name === name)?.input_schema as unknown as ObjectSchema;
  const startSpec = () => schemaOf('start_combat').properties.combatants.items as ObjectSchema;
  const addSpec = () => schemaOf('update_combat').properties.combatant as unknown as ObjectSchema;

  it('makes ac, hp_max and initiative_bonus optional, defaulting to the stat block', () => {
    for (const spec of [startSpec(), addSpec()]) {
      expect(spec.required).toEqual(['name', 'side']);
      expect(spec.properties.ac.description).toBe("Armor Class. Omit to use the stat block's (the SRD's or a reviewed import's).");
      expect(spec.properties.hp_max.description).toBe("Hit point maximum of each creature. Omit to use the stat block's.");
      expect(spec.properties.initiative_bonus.description).toBe("Initiative modifier. Omit to use the stat block's.");
      for (const key of ['size', 'speeds', 'reach_ft']) expect(spec.properties[key].description).toContain('Default: from the stat block (SRD or a reviewed import)');
    }
  });

  it('says so in start_combat, and tells level_up what the app adds for imported classes', () => {
    expect(TOOL_DESCRIPTIONS.start_combat).toContain(
      "Leave AC, HP and initiative out to use the stat block's (the SRD's or one the player reviewed); give them for creatures without one, or to adjust one.",
    );
    expect(TOOL_DESCRIPTIONS.start_combat).toContain('a stat block (SRD or reviewed import) supplies size, speed and reach');
    expect(TOOL_DESCRIPTIONS.start_combat).not.toContain('Use real values');
    expect(TOOL_DESCRIPTIONS.level_up).toContain(
      "For a class or subclass from the player's books the app adds that level's features with their text; use new_features only for anything extra.",
    );
  });
});

describe('toolActivity never names a creature for the map tools (hidden creatures, D41)', () => {
  const inputs: Record<(typeof MAP_TOOLS)[number], unknown> = {
    move_tokens: { moves: [{ who: 'Cutthroat', to: 'L8' }] },
    update_map: { creatures: [{ who: 'Cutthroat', size: 'Large' }] },
    resolve_area: { label: 'Cutthroat poison cloud', shape: 'sphere', size_ft: 10, at: 'Cutthroat' },
    check_map: { from: 'Cutthroat', to: ['hero'] },
  };

  it.each(MAP_TOOLS)('%s', (name) => {
    expect(toolActivity(name, inputs[name])).not.toContain('Cutthroat');
    expect(toolActivity(name)).not.toContain('Cutthroat');
  });

  it('shows "Rolling an attack…" for roll_dice with an attacker, never its purpose', () => {
    expect(toolActivity('roll_dice', { expression: '1d20+5', purpose: 'Cutthroat stabs Mira', attacker: 'Cutthroat', target: 'hero' })).toBe('Rolling an attack…');
    expect(toolActivity('roll_dice', { expression: '1d20+5', purpose: 'Cutthroat stabs Mira', attacker: 'Cutthroat', secret: true })).toBe(
      'Rolling dice behind the screen…',
    );
    expect(toolActivity('roll_dice', { expression: '1d20+5', purpose: 'Bandit attacks' })).toBe('Rolling: Bandit attacks…');
  });

  it("keeps a purpose that names a hidden creature behind the screen (amendment 8)", () => {
    const isSecret = (text: string) => /cutthroat/i.test(text);
    expect(toolActivity('roll_dice', { expression: '1d20+7', purpose: 'Cutthroat Stealth' }, { isSecret })).toBe('Rolling dice behind the screen…');
    expect(toolActivity('roll_dice', { expression: '1d20+3', purpose: 'Bandit attacks' }, { isSecret })).toBe('Rolling: Bandit attacks…');
  });
});
