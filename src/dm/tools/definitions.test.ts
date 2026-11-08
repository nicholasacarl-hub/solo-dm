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

  it('keeps each map schema under 8,000 characters and every description substantial', () => {
    for (const tool of DM_TOOLS) {
      expect(JSON.stringify(tool.input_schema).length, tool.name).toBeLessThan(8000);
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
