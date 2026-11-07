/**
 * Tool dispatch: validate each tool input against its Zod schema (eager input streaming means
 * the API did not), run the handler, and turn problems into is_error results Claude can fix.
 * Invalid input never reaches a handler.
 */
import type { z } from 'zod';
import { DmCancelledError, isAbortError } from '../errors';
import { getCharacterSheetTool, levelUpTool, takeRestTool, updateCharacterTool } from './character';
import { endCombatTool, startCombatTool, updateCombatTool } from './combat';
import { ToolInputError, type ToolContext, type ToolOutcome } from './context';
import { isToolName, TOOL_SCHEMAS, type ToolInput, type ToolName } from './definitions';
import { requestPlayerRoll, rollDiceTool } from './rolls';
import { createHomebrewTool, getEntryTool, lookupRulesTool, updateHomebrewTool } from './rules';
import {
  consultOracleTool,
  searchMemoryTool,
  setSceneTool,
  updateClocksTool,
  updateJournalTool,
  updateQuestTool,
} from './world';

type Handler<N extends ToolName> = (input: ToolInput<N>, ctx: ToolContext) => Promise<ToolOutcome>;

const HANDLERS: { [N in ToolName]: Handler<N> } = {
  roll_dice: rollDiceTool,
  request_player_roll: requestPlayerRoll,
  update_character: updateCharacterTool,
  take_rest: takeRestTool,
  level_up: levelUpTool,
  start_combat: startCombatTool,
  update_combat: updateCombatTool,
  end_combat: endCombatTool,
  lookup_rules: lookupRulesTool,
  get_entry: getEntryTool,
  get_character_sheet: getCharacterSheetTool,
  create_homebrew: createHomebrewTool,
  update_homebrew: updateHomebrewTool,
  update_journal: updateJournalTool,
  update_quest: updateQuestTool,
  update_clocks: updateClocksTool,
  search_memory: searchMemoryTool,
  set_scene: setSceneTool,
  consult_oracle: consultOracleTool,
};

/** "entries.0.name: Required; dc: Too big; (input): unknown field "DC" — …" */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const where = issue.path.length ? issue.path.join('.') : '(input)';
      if (issue.code === 'unrecognized_keys') {
        const keys = issue.keys.map((k) => `"${k}"`).join(', ');
        return `${where}: unknown field${issue.keys.length > 1 ? 's' : ''} ${keys} — use only the fields in this tool's schema (names are case-sensitive)`;
      }
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}

function preview(input: unknown): string {
  const json = JSON.stringify(input) ?? 'undefined';
  return json.length > 600 ? `${json.slice(0, 600)}…` : json;
}

async function dispatch<N extends ToolName>(name: N, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const parsed = TOOL_SCHEMAS[name].safeParse(rawInput);
  if (!parsed.success) {
    return {
      isError: true,
      content: `Invalid input for ${name} — nothing was done. ${formatIssues(parsed.error)}. Received: ${preview(rawInput)}. Fix the input and call the tool again.`,
    };
  }
  const handler = HANDLERS[name] as Handler<N>;
  return handler(parsed.data as ToolInput<N>, ctx);
}

/**
 * Run one tool call. Never throws for tool problems (they become is_error results); throws
 * DmCancelledError when the player cancelled while the tool was running.
 */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!isToolName(name)) {
    return { isError: true, content: `Unknown tool "${name}". Use one of the tools you were given.` };
  }
  try {
    return await dispatch(name, rawInput, ctx);
  } catch (err) {
    if (ctx.signal.aborted || isAbortError(err)) throw new DmCancelledError();
    if (err instanceof ToolInputError) return { isError: true, content: err.message };
    const reason = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `The ${name} tool failed: ${reason}. Check the current state before trying again.` };
  }
}
