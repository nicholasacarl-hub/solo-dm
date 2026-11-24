/**
 * DM_TOOLS is sent with every DM request (request.ts): any change to its bytes rewrites the cache prefix
 * of every session in progress and drops their earlier thinking blocks (CLAUDE.md rule 1). This pins
 * today's array. It has changed twice, each a deliberate change reviewed with its one-time cost:
 * - the structured-imports batch, E1 (spec §6.5: optional ac / hp_max / initiative_bonus on start_combat
 *   combatants, three description edits);
 * - Hit Point maximum adjustments (update_character hp_max, hp_max_end, hp.drain and initiative_change, with
 *   the update_character and take_rest descriptions).
 * Each was regenerated once with
 *   npx vitest run src/dm/tools/definitions.snapshot.test.ts -u
 * Nothing else may update this snapshot.
 */
import { describe, expect, it } from 'vitest';
import { DM_TOOLS } from './definitions';

const TOOL_NAMES = [
  'roll_dice', 'request_player_roll', 'update_character', 'take_rest', 'level_up', 'transform_character', 'start_combat',
  'update_combat', 'end_combat', 'move_tokens', 'update_map', 'resolve_area', 'check_map', 'lookup_rules', 'get_entry',
  'get_character_sheet', 'create_homebrew', 'update_homebrew', 'update_journal', 'update_quest', 'update_clocks',
  'search_memory', 'set_scene', 'show_image', 'consult_oracle',
];

describe('DM_TOOLS bytes', () => {
  it('keeps its 25 tools in the same order', () => {
    expect(DM_TOOLS.map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  it('equals the committed snapshot byte for byte', async () => {
    // Pretty-printed for readable diffs; the same object, so the compact bytes the SDK sends are pinned too.
    await expect(`${JSON.stringify(DM_TOOLS, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/dm-tools.json');
  });
});
