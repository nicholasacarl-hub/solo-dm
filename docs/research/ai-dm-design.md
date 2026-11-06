# Designing an AI Dungeon Master

> Research notes gathered on 2026-11-06 while designing Solo DM. Sources are cited inline; verify before relying on them.

## 1. Prior art (late 2026)

- **AI Dungeon (Latitude):** freeform story with Story Cards, Plot Essentials, auto-summary and a Memory Bank. Complaints: summaries drift ("an AI summarizing an AI"), cards that trigger are silently dropped from context, and the AI is too positive. Latitude open-sourced *Wayfarer*, trained to be pessimistic after players said models let them win too easily. With no rules engine, nothing is at stake.
- **Latitude Voyage (Apr 2026):** a "World Engine" tracks HP, inventory, money, geography and relationships over thousands of turns, so the model can't invent or contradict state. Stat-based checks decide outcomes. The industry is converging on "the app owns state."
- **Friends & Fables ("Franz"):** the closest competitor. SRD 5.1 rules, character sheets, initiative, spell-slot enforcement, maps, a world wiki, homebrew and suggested actions. Complaints on its own feedback board: hallucinations, using STR instead of DEX for monk attacks, rushed pacing and fake tension, dead scenes, daily turn caps.
- **Everweave:** good recall. Criticized for per-message pricing (the DM "stretches encounters") and drifting from the SRD.
- **Open source:** Talemate (separate narrator, director, summarizer and world-state agents) and DnD-MCP (a Claude MCP server with deterministic dice, state patch/checkpoint and rules lookup).
- **Research:**
  - *Setting the DC* (NeurIPS 2025): even a DM forced to act through typed function calls piles up state-tracking errors over long play.
  - *Static vs Agentic GM* (arXiv 2502.19519, only 12 participants): a separate Narrator and Archivist beat one big prompt on immersion, flow and autonomy.
  - A June 2026 paper found LLM accuracy falls to about 0.59 on counterintuitive dice-probability problems, so the app should compute the odds.

Recurring complaints, most common first (my ranking): contradictions and forgetting, rules errors, no real failure, pacing and verbosity, turn caps. Using the player's own API key removes turn caps.

## 2. Failure modes and mitigations

- **Fudged or invented dice and stats:** all randomness comes from the app (`crypto.getRandomValues`). A rules engine, not the model, computes derived stats (attack bonus, save DC, AC). Keep a public dice log, and flag any number in the narration that no tool result this turn produced.
- **Forgotten state:** the app owns all state. Append a compact state card every turn, give every entity an ID, and inject entity cards by rule rather than leaving it to the model.
- **Sycophancy:**
  - The DC and the stakes are fixed in the tool call *before* the roll. No retcons.
  - Failure always costs something (fail forward).
  - The player states intent and cannot assert facts or items ("I drink my potion" triggers an inventory check).
  - Enemies fight to win.
  - A difficulty preset (Story/Standard/Gritty) sets encounter budgets; the DM shows no mercy mid-fight.
- **Railroading vs. aimlessness:** run situations, not plots. Keep 2–3 threats ("fronts") with progress clocks that tick off-screen. When the player stalls, offer 2–3 options or a complication.
- **Purple prose:** default to about 120 words per turn (adjustable). End at a decision point, ask at most one question, and never narrate the PC's actions or feelings.
- **Rules drift:** `rules_lookup` returns cited text from SRD 5.2.x and imported books. Each ruling is logged as a house rule so it stays consistent.
- **Homebrew power creep:** a proposal must name SRD items or spells it compares to, plus a power tier. The app flags outliers, the player approves or vetoes, and every change goes into a versioned changelog.
- **Context bloat:** see Memory in section 4.

## 3. Solo techniques to build in

- **Oracle:** `oracle(question, likelihood)` on the Ironsworn odds ladder (90/75/50/25/10%); doubles mean a twist. The player can ask it directly too. The model sets the likelihood before the roll.
- **Tension dial (like Mythic's chaos factor, 1–9):** at scene start, roll a d10. At or under the tension value, the scene is altered (odd) or interrupted (even). Adjust tension after each scene by whether the PC was in control.
  - Reimplement the mechanic without copying Mythic's commercial tables.
  - Bundle Starforged's oracle tables, which are CC BY 4.0 (check each item's license in the Datasworn data).
- **Scene card:** goal, location, NPCs, stakes. Thread and NPC lists feed random events, which trigger on oracle doubles, the passage of exploration time and clock ticks.
- **Recaps:** a "Previously…" built from the event log. The player can edit it, and the edits become canon.
- **Safety:** a session-zero form for lines (never shown) and veils (fade to black), plus content dials. Add an always-visible X-card/pause button and an out-of-character (OOC) channel.
- **Rolls:**
  - The player rolls their own checks, saves, attacks and damage in a dice tray, or enters results from physical dice.
  - DM rolls (monsters, hidden DCs, passive Perception) are hidden but logged.
  - A "DM screen" reveal after each scene lets the player audit them, a trust feature I didn't see any competitor advertise.
- **Solo balance:** one PC loses the action-economy fight. Offer a DM-run companion, fewer but tougher foes, and generous Heroic Inspiration.

## 4. Architecture

**State the app owns.** Each save slot lives in IndexedDB with JSON export. The static build deploys from the user's GitHub repo to GitHub Pages. Imported book text never leaves the device and never goes into a commit.
- **Character:** abilities, derived stats, HP/Hit Dice, spell slots and resources, conditions, concentration, Heroic Inspiration, weapon masteries, inventory, XP.
- **Combat:** initiative, combatants (HP, AC, conditions, reactions), round, zones.
- **World:** entities (NPC, location, faction, item, lore) with IDs, aliases, facts stamped with the turn they appeared, and DM-only secrets. Also quests, fronts, clocks, calendar and tension.
- **Logs and content:** append-only event log, dice log, summaries, versioned homebrew registry, settings. SRD and imported text are split by heading and indexed for keyword search (BM25).

**Tools.** Declare them once per session, all with `strict: true`. Return invalid calls as `is_error` with the reason.
- `request_player_roll({type: check|save|attack|damage|initiative|death_save, ability, skill?, dc?, dc_visible, adv, stakes})`: pauses for the UI and returns the dice, the app-computed modifier, the total and the outcome.
- `roll({expr, purpose, visibility})`
- `resolve_attack({attacker_id, target_id, attack, adv})`: the engine rolls against AC and applies damage.
- `apply_effect({target_id, hp_delta?, damage_type?, condition?, duration?, resource?})`: the engine enforces resistances, slots and concentration.
- `inventory({op, item_ref, qty})`, `award({xp?, milestone?, currency?})`, `combat({op: start|next_turn|end, combatants?})`
- `rules_lookup({query, sources?, k})`, `oracle({question, likelihood})`, `random_table({table_id})`
- `scene({op: start|end, goal, location_id, npc_ids, summary?, tension_delta?})`
- `world_upsert({type, id?, name, aliases, facts_add, facts_retract, secret?})`, `world_recall({query?, ids?})`, `quest_upsert({id?, title, status, objectives, clock?})`
- `homebrew_propose({kind: spell|item|monster|boon|feat|rule_change, base_ref?, mechanics, comparables, tier, drawback?, rationale})`, `homebrew_revise({id, changes, reason})`
- `dm_note({text})`: private foreshadowing and secrets.

**Turn loop:**
1. The player's input and the state card go in.
2. The model calls tools.
3. The app runs them, waiting for player rolls, and returns all results in one user message.
4. The model narrates.

Only tools change state. At scene end, an "Archivist" pass (low effort) turns the event log into a summary and a list of fact changes, which the app validates.

**Memory:**
- **Prompt layout, in order:**
  1. Tools.
  2. A frozen system prompt (DM rules plus a digest of the 2024 core rules), ending in an explicit cache breakpoint.
  3. A campaign bible (setting, PC, safety settings, homebrew, story so far), rewritten only between scenes.
  4. The append-only scene transcript.
  5. The latest input, the state card, and entity cards for any names it mentions.
- **Scene-scoped conversations:** each scene starts a fresh `messages` array seeded with summaries. Within a scene, only append. On Opus 5.5, editing earlier turns or the system prompt invalidates thinking blocks, and accounts created on or after 2026-08-31 get a 400 error. Send changes as appended text or mid-conversation `role: "system"` messages instead. For long combats, use `clear_tool_uses_20250919` context editing or `compact-2026-01-12` compaction.
- **Summaries:** build them from the event log and state changes, not from the prose, so summaries of summaries don't drift. Write one per scene (about 150 words), one per chapter (about every 8 scenes), and a campaign synopsis. The facts table is the ground truth.
- **Retrieval:** alias matching for entities, `world_recall`, and BM25 over summaries and rules. Embeddings can come later.
- **Caching:** Opus 5.5 caches prefixes of 512+ tokens. Cache reads cost $0.20/MTok (5% of the input price); writes cost 1.25× with the 5-minute TTL or 2× with the 1-hour TTL; a request can have at most 4 breakpoints. Solo players often pause 5–60 minutes, so use the 1-hour TTL on both the static-prefix breakpoint and the automatic tail. Check `cache_read_input_tokens`, and keep timestamps out of the prefix.
- **API:**
  - Use `claude-opus-5-5` at low or medium effort for narration and higher effort for homebrew.
  - Thinking stays hidden by default, so it can't spoil secrets.
  - Forced `tool_choice` returns a 400 error; use `auto` and steer from the prompt.
  - Handle `stop_reason: "refusal"` with server-side fallbacks.
  - The player's own API key goes through the TypeScript SDK's `dangerouslyAllowBrowser` option and stays on the device.

**System-prompt essentials:**
1. You are the DM; the player controls only their character. Write in second person, present tense, about 120 words, ending at a decision point. Never narrate the PC's choices, words or feelings.
2. Order of truth: tool state, then `rules_lookup`, then campaign facts, then improvisation. Never state a number no tool produced. Rule on ambiguities in one line and log the ruling.
3. Call for a roll only when the outcome is uncertain *and* failure matters; otherwise just say yes or no. Set the DC (5–30) and the stakes before the roll. The player rolls through `request_player_roll`; NPC and secret rolls use `roll` with hidden visibility.
4. Honor every result: failure changes the situation, enemies fight smart, and death is possible. Never retcon, and never accept facts or items the player simply asserts.
5. Advance the fronts with clocks, offer hooks, and follow the player's lead.
6. Homebrew freely, but only through `homebrew_propose`, with SRD comparisons. Prefer boons that carry a cost over bigger numbers, and announce rule changes before they affect a roll.
7. Record every new named NPC, place, faction or item with `world_upsert`. Keep secrets in `dm_note`.
8. Lines are absolute and veils fade to black. On the X-card, step out, adjust, and carry on without lecturing. Answer "OOC:" messages plainly, out of character.

Sources: [Friends & Fables feedback](https://feedback.fables.gg/p/core-gameplay-is-unreliable-and-full-of-hallucinations), [F&F 30-hour review](https://feedback.fables.gg/p/review-of-system-after-30-hours-of-play), [F&F features](https://fables.gg/patch-notes/combat-v3), [AI Dungeon memory](https://help.aidungeon.com/faq/the-memory-system), [Wayfarer](https://ollama.com/Desmon2D/Wayfarer-12B:Q4_K_M), [Voyage](https://techcrunch.com/2026/04/21/voyage-is-an-ai-rpg-platform-for-creating-custom-gaming-worlds-with-ai-generated-npc-interactions), [Everweave reviews](https://fr.trustpilot.com/review/everweave.ai), [Talemate](https://github.com/vegu-ai/talemate), [DnD-MCP](https://lobehub.com/fr/mcp/wyatt727-dnd-mcp), [Setting the DC](https://neurips.cc/virtual/2025/128312), [Static vs Agentic GM](https://arxiv.org/html/2502.19519v1), [LLM dice reliability](https://arxiv.org/abs/2606.07515), [SRD 5.2 CC-BY](https://www.dndbeyond.com/forums/d-d-beyond-general/news-announcements/219555-news-srd-5-2-is-now-available), [Starforged licensing](https://tomkinpress.com/pages/licensing).
