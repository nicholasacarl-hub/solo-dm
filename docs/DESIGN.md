# Solo DM — Design

Solo DM is a browser app for playing solo tabletop campaigns with Claude as the Dungeon Master.
It is compatible with fifth edition (the 2024 rules, via SRD 5.2.1).

## Principles

1. **Claude narrates and adjudicates; the app keeps the books.** Hit points, spell slots, inventory,
   initiative, dice and quest state live in the app. Claude changes them only through tools, and the
   player sees every change as a line in the log. Claude never invents a die result.
2. **The player keeps agency.** The DM never decides what the player character does, thinks or says.
   Checks the player makes are rolled by the player (auto, tap-to-roll, or physical dice).
3. **Real stakes.** Failure is possible and has consequences ("fail forward"), scaled by the
   campaign's difficulty setting. The DM is not a yes-man.
4. **Rules first, creativity always.** The DM follows the 2024 rules (SRD 5.2.1 + whatever the player
   imported) per the campaign's rules-fidelity setting, and may homebrew within the campaign's
   homebrew-freedom setting. Homebrew is transparent, balanced against SRD benchmarks, and saved to the
   campaign compendium where the player can read, edit or retire it.
5. **Everything is local and portable.** Saves, imports and the API key stay in this browser.
   Campaigns export to a file and can optionally sync to the player's own private GitHub repo.
6. **No copyrighted content in the repo.** Only CC-BY-4.0 SRD 5.2.1 content ships. The player's purchased
   books are imported into their own browser storage and are never committed or uploaded.

## Architecture

```
src/
  types/        Shared domain types (the contract). Character, Campaign, Session, LogEntry, ...
  engine/       Pure rules logic: dice, derived stats, damage/healing, slots, rests, leveling,
                combat tracker, oracle, conditions, text summaries. No React, no I/O. Unit-tested.
  data/         SRD 5.2.1 loaders, the rules search index (MiniSearch over SRD + imports + homebrew),
                character-builder data, the import pipeline (paste / PDF / photo via Claude vision).
  storage/      IndexedDB (Dexie) persistence, save slots, export/import bundles, GitHub sync.
  state/        Zustand stores: gameStore (the loaded campaign; write-through to storage),
                settingsStore (browser-only settings and the API key).
  dm/           The AI DM: client, system prompt, tool definitions + handlers, the streaming agent
                loop, session lifecycle (start / recap / end), the offline mock DM.
  ui/           React screens and components.
public/srd/     Generated SRD 5.2.1 JSON (lazy-loaded at runtime).
scripts/        build-srd.mjs converts the upstream SRD dataset into public/srd/.
```

Data flow during play:

```
Player types → dm.sendPlayerMessage → agent loop (stream from Claude)
   ├─ text deltas → gameStore.updateLog(dm entry, persist:false) → UI renders live
   ├─ tool_use → handler → engine (pure) → gameStore actions (write-through) → log entries
   │                └─ request_player_roll → gameStore.requestInteraction → UI dialog → player rolls
   └─ end_turn → final dm entry persisted; choices chips rendered
```

## The DM harness (src/dm)

Model defaults: `claude-opus-5-5`, adaptive thinking (always on for this model), effort `medium`,
streaming, `max_tokens` 32000. The player can pick Sonnet 5.5 / Haiku 5.5 and effort in Settings.

**Sessions are the unit of context.** A campaign is played in sessions, like at a real table.
Within a session the API conversation is **append-only**:

- The `system` prompt is built once when the session starts and stored on the Session (frozen).
  It contains the DM instructions, campaign settings, the chronicle (recaps of earlier sessions plus
  the DM's private notes), and a snapshot of the character, quests, journal, homebrew and scene.
- The `tools` array is static and identical for every request (deterministic order).
- Each player turn appends one user message: a compact `<game_state>` status block, then the
  player's words. Mid-session operator notes (player edited the sheet, changed a setting) are appended
  as `role: "system"` messages after that user message.
- Nothing earlier is ever edited. Regenerate/cancel only trims from the END of the transcript.
- Thinking blocks are passed back unchanged. Requests set
  `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta
  `thinking-binding-controls-2026-08-01`) so an accidental prefix change degrades instead of failing.

This keeps prompt caching effective (explicit breakpoint on the system prompt + automatic caching of
the conversation tail; TTL from Settings, default 1h because players pause between turns) and keeps
preserved thinking valid.

**Ending a session** (player clicks End Session, or the DM suggests it, or the context passes the
soft limit): the app appends a wrap-up instruction; the DM records any missing journal/quest updates
via tools, then writes `## Recap` (player-facing) and `## DM Notes` (private plans/secrets). The
session is marked ended. The next session starts a fresh conversation whose system prompt carries
the chronicle — "simple compaction", which is compatible with preserved thinking.

**Interruptions and recovery** (all append-only):

- *Stop* after text appeared appends the visible text as a text-only assistant message, plus a note
  that the reply was cut off; Stop before any text carries the player's words into their next turn
  in an `<unanswered_turn>` block.
- A reload in the middle of a tool batch: each finished tool's result is saved on the session
  (`pendingToolResults`) as it completes, so recovery returns the real results for finished tools and
  an "interrupted — check the current state" note only for the one in flight (no double damage).
- DM notices (sheet edits, vetoes, Library homebrew edits) persist on the campaign record until
  delivered; a new session delivers them with its opening request.
- One tab at a time: the play screen holds a per-campaign Web Lock; the store refuses writes to a
  campaign another tab holds.
- Rules lookups search the SRD, every import switched on in the Library, and homebrew.

**Refusals and errors:** `stop_reason: "refusal"` is handled before reading content. On models that
support it, requests opt into server-side fallbacks (`fallbacks: "default"`, beta
`server-side-fallback-2026-07-01`). Typed SDK errors map to friendly log errors with Retry.
Invalid tool input (eager input streaming means the client validates) returns an `is_error`
tool_result so Claude can correct itself.

### Tool catalog

| Tool | Purpose |
|---|---|
| `roll_dice` | DM rolls (NPC attacks, damage, random tables, secret checks). `secret` hides it unless the campaign shows DM rolls. |
| `request_player_roll` | Ask the player to roll a check/save/attack/damage/initiative/death save. Uses the sheet's modifiers; resolves per roll mode (auto / tap / physical). Returns total, natural, success vs DC. |
| `update_character` | Batched sheet changes: HP (damage/healing/temp), conditions, exhaustion, slots, feature uses, inventory, currency, XP, inspiration, features, spells, concentration, AC/speed. Returns a summary and warnings. |
| `take_rest` | Short rest (player chooses hit dice in a dialog) or long rest. |
| `level_up` | Apply a level (HP, hit dice, slots, proficiency, new features) and return reminders for choices. |
| `transform_character` | Begin, advance or end a **transformation** (vampirism, lycanthropy, a fey mark...): features, defenses, senses, speeds, size and ability changes applied atomically and recorded with what they granted, so ending one undoes exactly that. Enforces the campaign's transformations rule (see below). |
| `start_combat` / `update_combat` / `end_combat` | Initiative tracker: add combatants (auto-numbered), roll NPC initiative, request the player's, advance turns, damage/heal/conditions on NPCs, end with a summary. |
| `lookup_rules` | Search SRD 5.2.1 + enabled imports + homebrew. |
| `get_entry` | Full text of one spell / monster / item / feature by name. |
| `get_character_sheet` | Full current sheet. |
| `create_homebrew` / `update_homebrew` | Create or modify homebrew (refused when the campaign disables homebrew). |
| `update_journal` | Upsert NPCs, locations, factions, lore, secrets (DM-only when `secret`). |
| `update_quest` | Upsert quests and objectives. `ambition: true` marks a goal the player set for the hero (found a guild, take the throne): no DM-invented checklist, progress on a progress clock. |
| `search_memory` | Search journal, quests and earlier session recaps. |
| `set_scene` | Location, time of day, weather, in-world date, mood (shown in the scene header). With `new_scene: true` the app runs a **scene check** against the tension dial (d10 ≤ tension → altered if odd, interrupted if even) and returns a twist to build on; `tension_change` nudges the dial (+1 when things slip out of the hero's control, −1 when they take charge). |
| `update_clocks` | Upsert progress clocks: threats/fronts that advance off-screen, countdowns, long projects. Filling a clock triggers its consequence. Secret clocks are hidden from the player. |
| `show_image` | Ask for an illustration (scene, hero, NPC, creature, item, battle). Returns at once; the picture is painted in the background with the player's OpenAI key and appears in the log. Allowed only as the illustrations setting says. |
| `consult_oracle` | Yes/no oracle with likelihood for questions the DM genuinely can't answer from the fiction. The DM sets the likelihood before rolling. |

Rulings: when the DM makes a call the rules don't settle, it records it with `update_journal`
(kind `ruling`) so later calls stay consistent; rulings appear in the Journal as house rules.

### Story systems: homebrew, transformations, ambitions, illustrations

- **Homebrew on the fly.** The prompt encourages the DM to improvise rewards, monster variants,
  bargains, boons and curses whenever the story calls for them, within the campaign's homebrew
  freedom, balanced against named SRD comparables and saved with `create_homebrew`.
- **Transformations** are lasting, story-driven changes to who the hero is. The campaign's
  transformations rule (Table rules) decides what's allowed: *Off* (the hero stays as built; an
  active one can still be ended), *Offered* (the default: temptations and bargains, but nothing
  begins or advances unless the player chooses it, `origin: "accepted"` with `player_chose_it`), or
  *Consequences* (the player's knowing choices can also impose one, `origin: "imposed"`, always
  telegraphed and always with a way back in `how_it_ends`). There is no quota: never shoehorned in,
  never withheld when the player pursues one. Each brings costs as well as powers and may unfold in
  stages. The engine (src/engine/transform.ts) records what each one granted, so ending it removes
  only that, even when two transformations grant the same defense.
- **Ambitions and an indifferent world.** The player may take the story anywhere. A goal the player
  commits to (found a thieves' guild, take the throne) becomes an ambition: no checklist the DM
  invented, progress only for what the hero earns, tracked on a 6–12 segment progress clock that can
  go back, usually paired with a threat clock. Mistakes can close the door. NPCs and factions pursue
  their own interests.
- **Illustrations** (src/images) are optional and use the player's own OpenAI key. Settings →
  Illustrations picks when the DM may paint (*Off*, *When I ask*, *Key moments*: at most about one
  per scene), the model and the quality. The DM writes the description; the app adds the campaign's
  art style, the hero's look from the sheet when they're in frame, and guardrails (no text, maps or
  UI). A pending card appears in the log at once and turns into the picture; at most two paint at a
  time. Pictures live in IndexedDB on this device only: exports and GitHub saves keep the log entry
  but never the picture or prompt. The sheet's Paint portrait and the Gallery tab use the same store.
- **Settings that change mid-session.** The frozen system prompt renders the current transformations
  rule and illustrations mode. When either changes, the next turn's system note carries a one-line
  "Setting update — …" with the new guidance (src/dm/modes.ts); nothing earlier is edited.

### Grounding each turn

The `<game_state>` block appended to each player message contains: the character status line,
the scene, the combat summary (if any), open clocks, and **entity cards** — short journal entries
for any known NPC / place / faction / item whose name (or tag alias) appears in the player's message
or in the DM's previous narration. This is cheap retrieval that prevents contradictions.

### Player-side controls that talk to the DM

- **OOC:** messages starting with `OOC:` (or sent with the OOC toggle) are answered out of character
  and don't advance the story.
- **X-card:** a always-available button that tells the DM to steer away from the current content,
  without discussion, and adds the topic to the campaign's veils if the player wants.
- **Veto homebrew:** homebrew cards in the log have a Veto action; the DM is notified next turn and
  retires or reworks it.
- **Manual edits:** when the player edits the sheet, quests or journal by hand, a DM notice is queued
  and delivered as a `role: "system"` note with the next player message.
- **Behind the screen:** secret DM rolls are logged; the player can reveal them per roll or for the
  whole session (trust, auditable fairness).

Narration may end with a fenced block that the UI renders as tappable suggestions:

````
```choices
Slip past the guards
Bluff your way in
Wait for nightfall
```
````

## UX

Screens (hash routing, so GitHub Pages refreshes work):

- `#/` **Save slots** — campaign cards (cover emoji/color, name, character name · species · class
  level, last played, session count). Actions: Continue, New campaign, Duplicate, Export, Delete,
  Import save file. First run shows a welcome card explaining the API key and a "Try the demo DM"
  option (mock mode).
- `#/new` **New campaign** — a short wizard: (1) Premise & tone (pitch textarea, tone presets,
  setting notes, or "Surprise me"), (2) Table rules (rules fidelity, homebrew freedom, difficulty,
  narration length, roll mode, milestone vs XP, show DM rolls), (3) Safety (lines & veils with
  common presets), then on to the character.
- `#/campaign/:id/character` **Character builder** — 2024 order: class → background (ability score
  increases +2/+1 or +1/+1/+1 among its three abilities, origin feat, skills, tool) → species
  (+ lineage, size) → ability scores (standard array / point buy / 4d6-drop-lowest roll) → skills →
  equipment (class + background packages, or gold) → details (name, pronouns, alignment, personality,
  backstory, portrait emoji) → review. "Let the DM help" is always an option: the builder stays
  editable, and the DM can finish details during session one.
- `#/play/:id` **Play** — the table.
  - Desktop (≥1024px): left rail (scene header, quests, journal, homebrew), center narrative log +
    composer, right rail (character sheet; combat tracker on top when combat is active).
  - Mobile: narrative full-screen with a bottom tab bar (Story · Sheet · Combat · Journal · Rules);
    the composer sits above the tab bar.
  - Log rendering: DM narration in the serif narration style; player turns as right-aligned bubbles;
    rolls as compact dice cards (d20 face, modifier, total, DC, success/fail/crit styling); tool
    activity as small icon lines ("❤ HP 23 → 15 (8 slashing)"); session dividers; recaps as cards.
  - Composer: textarea (Enter to send, Shift+Enter newline), quick actions (Ask the DM a rules
    question (OOC), Roll a die yourself, Short/Long rest request), and a Stop button while streaming.
  - Interactions: roll prompts are a modal the player can't dismiss accidentally (the DM is waiting);
    they show the reason, modifier breakdown, advantage, DC if revealed, and "Roll" or a number input
    in physical mode.
  - Status: a slim activity bar ("The DM is thinking…", "Rolling for the goblins…").
  - Header: campaign name, session number, End session, context meter, cost estimate, settings.
- `#/library` **Library** — Browse SRD (by kind, search), My imports (paste/upload, enable/disable,
  delete), Homebrew (all campaigns; edit/retire), and the SRD attribution.
- `#/settings` **Settings** — API key (test button, remember toggle, link to console.anthropic.com),
  model, effort, thinking display, cache TTL, session soft limit, illustrations (OpenAI key, when the
  DM may paint, model, quality, pictures stored on this device), theme, narration font & size, dice
  animations, demo mode, GitHub cloud saves (token, owner/repo, test, sync now), danger zone.

Visual system (see src/index.css): dark "candlelit table" (ink-blue night, ember accent) and light
"vellum". Meaningful accent colors: ember = primary action, crimson = harm, verdant = healing/success,
arcane violet = magic & homebrew, gold = treasure/XP. Cinzel only for small-caps section titles and
the wordmark; Spectral for narration; Inter for UI. Avoid gradients, glassmorphism, and emoji-heavy UI
chrome (emoji are fine for campaign covers and portraits).

## Content & licensing

- Bundled rules: SRD 5.2.1, CC-BY-4.0. The attribution statement (in `SRD_ATTRIBUTION`) appears in
  the Library, the README, and ATTRIBUTION.md. Our JSON is a modified (converted) form of the SRD.
- Describe the app as "compatible with fifth edition"; never use Wizards' trademarks in branding.
- Imported content is stored only in IndexedDB on the player's device. Passages the DM looks up from
  imported books are wrapped in `<imported-content>` markers in tool results, and exports / GitHub
  saves redact them (src/lib/importedContent.ts); the DM's own narration may still paraphrase them.
  GitHub sync refuses public and internal repositories.
- One tab at a time per campaign: the play screen holds a Web Lock; a second tab offers "Use this tab
  instead".
- Production builds ship a Content Security Policy: the page talks only to itself,
  api.anthropic.com, api.github.com and api.openai.com (illustrations, only with the player's key).
