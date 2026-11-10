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
   Book text copied onto a character remembers where it came from: exports and GitHub saves keep the
   names and leave the text out, and a device that has the book fills it back in.
6. **No copyrighted content in the repo.** Only CC-BY-4.0 SRD 5.2.1 content ships. The player's purchased
   books are imported into their own browser storage and are never committed or uploaded.
7. **Nothing from a book changes the game until the player checks it.** Structured records sit beside the
   imported text and feed the builder, combat and the DM only once accepted; app code parses every number.

## Architecture

```
src/
  types/        Shared domain types (the contract). Character, Campaign, Session, LogEntry, ...
  engine/       Pure rules logic: dice, derived stats, damage/healing, slots, rests, leveling,
                combat tracker, oracle, conditions, text summaries. No React, no I/O. Unit-tested.
  data/         SRD 5.2.1 loaders, the rules search index (MiniSearch over SRD + imports + homebrew),
                character-builder data, the import pipeline (paste / PDF / photo via Claude vision),
                structured imports (data/structured: detection, parsers, normalizers, materialize, merge,
                restore, packs) and option lookups (data/options).
  storage/      IndexedDB (Dexie) persistence, save slots, export/import bundles (with export redaction),
                GitHub sync, structured records and extraction jobs.
  state/        Zustand stores: gameStore (the loaded campaign; write-through to storage),
                settingsStore (browser-only settings and the API key).
  dm/           The AI DM: client, system prompt, tool definitions + handlers, the streaming agent
                loop, session lifecycle (start / recap / end), the offline mock DM; structuring
                (dm/extract: the job runner and its API; every request built in dm/libraryRequests.ts).
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
| `roll_dice` | DM rolls (NPC attacks, damage, random tables, secret checks). `secret` hides it unless the campaign shows DM rolls. On a battle map, `attacker` and `target` add distance, reach, line of sight and cover, and warn when a melee attacker is out of reach. |
| `request_player_roll` | Ask the player to roll a check/save/attack/damage/initiative/death save. Uses the sheet's modifiers; resolves per roll mode (auto / tap / physical). Returns total, natural, success vs DC. |
| `update_character` | Batched sheet changes: HP (damage/healing/temp), conditions, exhaustion, slots, feature uses, inventory, currency, XP, inspiration, features, spells, concentration, AC/speed. Returns a summary and warnings. |
| `take_rest` | Short rest (player chooses hit dice in a dialog) or long rest. |
| `level_up` | Apply a level (HP, hit dice, slots, proficiency, new features) and return reminders for choices. For an imported class or subclass the app adds that level's features with their text. |
| `transform_character` | Begin, advance or end a **transformation** (vampirism, lycanthropy, a fey mark...): features, defenses, senses, speeds, size and ability changes applied atomically and recorded with what they granted, so ending one undoes exactly that. Enforces the campaign's transformations rule (see below). |
| `start_combat` / `update_combat` / `end_combat` | Initiative tracker: add combatants (auto-numbered), roll NPC initiative, request the player's, advance turns, damage/heal/conditions on NPCs, end with a summary. AC, HP and initiative default to the stat block (SRD or reviewed import) when left out; `start_combat` can lay out a battle map (size, terrain, places, positions; size, speeds and reach default from the stat block); `update_combat` can `reveal` / `hide` creatures, and its `next_turn` result says where everyone stands. |
| `update_map` | Battle map: create, replace or remove it; add or clear terrain; open, close or lock doors; name places; set creatures' size, speeds and reach. |
| `move_tokens` | Every position change on the map: moves on the creature's own turn (turn guard), off-turn moves, forced movement, teleports and placement. The engine prices the path (SRD grid rules), stops at Opportunity Attacks (asking the player in-tool when the hero can react), refuses illegal moves with the nearest reachable square, and records the turn's movement. |
| `resolve_area` | Areas of effect (sphere, cylinder, cone, line, cube, emanation, listed squares): who is caught, with cover; lasting areas become terrain (difficult, obscured, hazard). |
| `check_map` | Read-only: measure distance, line of sight and cover, plan a path, preview an area, or draw the map. |
| `lookup_rules` | Search SRD 5.2.1 + enabled imports + homebrew. |
| `get_entry` | Full text of one spell / monster / item / feature by name (reviewed imports add their stats line; other entries with the same name are listed). |
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

### Battle map

Fights where positions matter get a square grid (5-ft squares, SRD 5.2.1 "Playing on a Grid"). The campaign's
battle-maps table rule picks *Off* (theater of the mind), *When it helps* (the default) or *Every fight*; it reaches
the DM mid-session like the transformations rule.

- **State.** The map lives on the combat (`CombatState.map`: size, terrain, places, lasting effects, this turn's
  movement and any pending Opportunity Attack stop). Each `Combatant` carries its position, elevation, size, speeds,
  reach, `hidden` and whether its Reaction is used. Everything is optional, so old saves load as "no map"; one
  normalizer (`src/engine/mapNormalize.ts`) cleans maps on load and import.
- **Engine** (`src/engine/grid|mapCells|sight|areas|movement|battleMap.ts`, pure and tested with SRD citations):
  grid distance (diagonals count 5 ft), Difficult Terrain, the corner rule, moving through and ending in other
  creatures' spaces, sizes, Prone, Speed 0, Frightened, Dash, switching speeds, swimming and flying, Opportunity
  Attacks (reach with no Total Cover between, line of sight, Disengage), areas, line of sight and suggested cover.
  Where the SRD is silent the app documents its convention: spheres and cylinders are round (square centres inside
  the radius), cones start at the caster's centre with grid-counted length, lines step square by square, cover comes
  from four corner lines. The engine returns data; `src/dm/mapText.ts` writes the DM's text and
  `src/ui/play/map/text.ts` the player's.
- **The DM.** A move is refused for anyone but the creature whose turn it is (catches a forgotten `next_turn`). A
  move that provokes stops on the last square in reach; for the hero as the reactor the tool asks the player
  ("Attack" / "Let it go") through the existing confirm interaction. Each player turn's `<game_state>` carries a
  compact map block (about 100–350 tokens: positions, distances and cover from the hero, who reaches whom, effects,
  the current creature's movement, anything new since the DM's last reply, a turn check). Terrain is never repeated
  per turn. A DM turn may take 40 requests while a mapped fight is active (24 otherwise).
- **The player.** On the hero's turn the player taps (or clicks, or uses the keyboard) to plan a move: the path, its
  cost, movement left, and warnings for Opportunity Attacks, hazards, Dash and Frightened, with Disengage offered.
  Moves commit at once and can be undone until the player sends; the DM learns about them from the next
  `<game_state>`. A move is "seen" only once a DM reply follows the message that carried it, so a failed request or
  a set-aside turn reports it again. Measure and area templates help plan; a template adds one `[Area: …]` line to
  the message. Desktop docks the map above the story (three sizes); phones show it on the Combat tab with a chip on
  the Story tab.
- **Hidden creatures.** Every player-facing computation runs on one redacted player view (`playerView`): hidden
  creatures, their turns, moves, reactions and effect labels never reach the player's screen, accessible text, log or
  tracker unless "Show DM secrets" is on. A player move that runs into something unseen stops and can't be undone.

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
  delete, structuring status), Homebrew (all campaigns; edit/retire), and About (the SRD attribution
  and how your books stay private).
- `#/library/source/:sourceId` **A book's page** — structure it (consent, progress, pause), review what
  was found (list · fields · source text on wide screens; list → full-screen detail on phones), an
  *All entries* view for anything detection missed (*Structure as…*), and the ⋯ menu (look again,
  re-check for free, *Download book data*, delete). Its view, filters and selection live in the URL.
- `#/settings` **Settings** — API key (test button, remember toggle, link to console.anthropic.com),
  model, effort, thinking display, cache TTL, session soft limit, illustrations (OpenAI key, when the
  DM may paint, model, quality, pictures stored on this device), theme, narration font & size, dice
  animations, demo mode, GitHub cloud saves (token, owner/repo, test, sync now), danger zone.

Visual system (see src/index.css): dark "candlelit table" (ink-blue night, ember accent) and light
"vellum". Meaningful accent colors: ember = primary action, crimson = harm, verdant = healing/success,
arcane violet = magic & homebrew, gold = treasure/XP. Cinzel only for small-caps section titles and
the wordmark; Spectral for narration; Inter for UI. Avoid gradients, glassmorphism, and emoji-heavy UI
chrome (emoji are fine for campaign covers and portraits).

## Structured imports

The player's imported books can be structured into per-kind **records** — classes, subclasses, species,
backgrounds, feats, spells, magic items, gear and monsters — that sit beside the raw library entries,
are reviewed by the player, and only then feed the rules index, the character builder, level-up,
combat, the battle map, spell lists, inventory and the DM. Contracts: `src/types/structured.ts`,
`src/data/structured/{wire,schemas}.ts`, `src/dm/libraryRequests.ts`, `src/dm/extract/`; the test book
is `src/test/structuredFixtures.ts` (invented content only).

**Pipeline.** Import is unchanged (read → Markdown → `chunkDocument` → `saveLibrarySource`) and stores
the book's fingerprint (FNV-1a over its entries in ordinal order). `detectStructure` then runs locally
and for free: it segments the entries in reading order, detects candidates by their labels, parses
what it can offline into the same wire object Claude returns, and normalizes it with one normalizer
per kind. What the offline reader can't read waits as *Not read yet* (the player can fill it in by hand).
With the player's consent — the model (the Settings model and the cheaper ones, each with a price range
and minutes), the kinds, and a spending limit — the runner sends one entry per request: streamed,
structured-output JSON, adaptive thinking at effort `low`, one cached system block per kind, a warm-up
request per kind before fanning out. Each answer is normalized the same way. **Claude labels, the app
parses**: Claude returns short verbatim excerpts and paragraph spans, never rules text or computed
numbers; app code parses, grounds and cross-checks every number. A request carries one entry's text and
nothing else (no book title, character or campaign). Extraction has its own ledger (`job.usage`) and
never touches a DM session, transcript or `Campaign.usage`.

**Detection rules and re-checks.** A feat is an entry with a category line ("General Feat (Prerequisite:
Level 4+)") or a name that says so; a bare "Prerequisite:" line counts only under a heading that names
feats (one that ends with the word, or "Feat Descriptions"), because books print other options that way
too (class options, stronghold rooms, item infusions). Entry kinds are guessed once, at import; when the
guessing rules change, a database upgrade corrects the stored kinds once (version 4 did this for feats;
imported text only, since a JSON file's kinds are its own). When the offline rules change,
`PARSER_VERSION` rises and the book page offers *Re-check for free*: it looks through the book again
(`detectStructure`). A record an older reader made that the current one doesn't find is removed when
nobody reviewed it; when the player had accepted or edited it, it keeps a note, and accepted ones go back
to review (Undo accepts them again). Rejected records, records being read, and records Claude, a pack or
the player made are left as they are.

**Running a job** (`src/dm/extract/runner.ts`). One job runs at a time across all books (others wait,
queued). Per kind, the first request's first stream event opens the lane (the kind's cache entry is then
readable); then up to the job's concurrency (1–4, default 3) run at once. A 429 pauses every lane until
`retry-after` and lowers the concurrency. Dispatch holds while a DM turn is running and while a phone's
page is hidden; requests in flight finish. The spending limit is checked before every dispatch against
what was spent, what is in flight and the next request. Pause is graceful (requests in flight finish and
are paid for); Cancel aborts them. A reload leaves the job paused, and nothing resumes a paid job without
the player, except that one paused offline continues when the connection returns in the same tab. The
runner holds the Web Lock `solo-dm:extract-runner`, so another tab neither runs nor "recovers" its job.
Each result is saved as it arrives. Requests set `maxRetries: 0` (the runner owns retries) under a
120-second no-event watchdog, use server-side fallbacks when Settings allow, and retry a `max_tokens`
stop once at double the limit; a refusal keeps whatever the offline reader found and can be retried on
another model.

**Storage** (Dexie version 3, and version 4's kind correction; `src/storage/structured.ts`): `libraryRecords` (one row per record, with
the run state of the latest job that touched it) and `libraryJobs`. Neither is part of
`campaignTables()`: like the library, they never leave the device. Every record write keeps the book's
denormalized counts (`LibrarySource.structure`) right in the same transaction; deleting a book removes
its records and jobs and is refused while a job runs.

**Records beside entries.** Nothing writes structure into `libraryEntries` (the version 4 upgrade only
corrected kinds the import itself had guessed). `getLibrarySnapshot()` reads
the enabled imports, their entries and their accepted, schema-valid records once per rules-index version;
`materializeEntries` turns accepted records into SRD-shaped index entries on read (a one-entry record keeps
its chunk id; sections and table rows get four-segment ids; replaced chunk ids stay resolvable as
aliases, so old links and `KnownSpell`/`statBlockId` ids keep working); `mergeBuilderData` adds the
accepted options to the builder data without mutating the SRD object (an SRD class that gains a
subclass is cloned). Un-accepting, switching a book off or deleting it reverts every consumer by
construction. Without imports the index contents and the builder data are exactly the SRD's.

**Review.** The book page (`#/library/source/:id`) lists what was found; nothing is used until the
player accepts it. *Accept N confident* takes only clean reads and never classes or subclasses; a
`block` warning disables Accept (with the reason); every bulk action has an Undo; accepted records can
move back to review. The detail shows "What the app and the DM will use" (the stats line below) next to
the source text with the excerpts highlighted; monster and magic-item details start collapsed (no
spoilers). A subclass must be attached to a class (pre-selected: this book, then the SRD, then another
book). Edits are checked with the same `DATA_SCHEMAS`; a re-run never overwrites an edited or accepted
record (it offers the new reading as a diff). Accepting refreshes the index and the builder data once
per batch and tells DMs with a session in progress (names and counts only). Switching a book off or
deleting it says which characters use it ("Used by Ember (The Drowned Lantern)…") and tells their DMs;
importing a book whose fingerprint is already in the Library warns that it looks like the same book.

**Consumers.** Accepted options join the builder data with a book badge (the SRD badge appears only on
a name clash, and same-name options coexist); lookups are id-first (`src/data/options/resolve.ts`), and
the engine never takes an imported class (`lib:` id) for an SRD class of the same name, so an imported
"Fighter" never borrows the SRD Fighter's numbers. Review warns about feature names the engine treats
specially (Alert, Tough, Defense…). Older-format (2014) options get one coherent set of app-written
adaptations, shown in review, on builder cards, in the DM's stats line and on the sheet. Level-up adds
an imported class's or subclass's features with their text (catching up subclass features a book
prints below the class's subclass level) and offers a feat at Ability Score Improvement, Epic Boon and
Fighting Style levels, with "Decide with my DM" preselected. Items copy numbers, never text: armor
stats, bonuses and attunement travel on the inventory item, so AC works in the DM's tools and on
another device. Accepted spells join spell lists and area templates.

Name lookups rank this campaign's homebrew, shared homebrew, **reviewed imports** (and a book's own
rules text), the SRD, then **unreviewed imported entities** — so a thin unreviewed duplicate never
shadows an SRD stat block (`search.ts` `sourcePriority`, mirrored by the DM's `findAllowedEntry`).
The DM's lookups put a one-line "Reviewed stats: …" (plus any "Adapted for 2024" note) inside the
imported-content wrapper and say "reviewed" in the heading; `get_entry` names other entries with the same
name. `start_combat` takes AC, HP and initiative from the stat block (the SRD's or a reviewed import's)
when the DM leaves them out, and says where they came from; the battle map takes size, speeds and reach
from it (`data.reachFt` first, then the attack lines, 2014 wording included, clamped to 5–60).

**The one deliberate `DM_TOOLS` change.** `start_combat` / `update_combat add` make `ac`, `hp_max` and
`initiative_bonus` optional (defaulting to the stat block; explicit numbers win; an error names what is
missing), three descriptions say "SRD or reviewed import", and `level_up` gains one sentence about
imported classes. The tools array is sent with every request, so every session in progress at the update
sends a changed prefix once: its first request rewrites the cache for the whole prefix (about $0.25–0.80
on Opus 5.5 for a 50–100K-token session) and its earlier thinking blocks are dropped by the request's
`drop_block` binding — a one-time dip in continuity, never a 400. Within every session afterwards the
array is static again (`definitions.snapshot.test.ts` pins it). Sessions started after the update with
imports get two system-prompt lines: what "reviewed" and "Adapted for 2024" mean, and that left-out
text can be read again with `get_character_sheet` / `get_entry`. Without imports the prompt is
byte-identical.

**Provenance, export redaction, restore.** Every copy of book text onto a character (features, traits,
lineages, feats, a background's feature; the DM's words about an imported entry) carries an
`ImportedRef`: the book's title and fingerprint, the option and part, where the text sits and its hash.
The sheet text wraps copied text after truncating, so the DM's frozen prompt can be redacted whole.
Exports and GitHub saves (`exportCampaignBundleWithReport`) replace copied descriptions — and the DM's
`level_up` / `update_character` inputs that echo them — with a placeholder sentence (the stored campaign
and transcript are never changed), then remove every wrapped passage; the download toast says what was
left out. Names stay, as titles always have. On a device that has the book, restore fills the text back
in — by option id, then by the book's fingerprint and the text's location (works before the book is
structured, or while it is switched off), then by title, then by a unique hash — only into empty or
placeholder descriptions, and writes the character as is: `updatedAt` and the campaign row don't change,
so sync sees no local edit. It runs after every load (pulls and bundle imports reload), after accepting
or enabling a book, and from the sheet.

**Packs and book data** (`docs/PACKS.md`). A `solo-dm-pack` JSON file carries entries and records;
records always import pending, invalid ones are skipped with their issues. "Download book data" (the book
page's ⋯ menu) writes one with the book's full text and review decisions, so a book moves to another of
the player's devices without structuring it again; on import the records the other device accepted are
offered with an unticked checkbox, never applied. Campaign exports and sync never import the pack module.

**Demo mode and no key**: detection, offline reading, review and packs work; starting a job or
transcribing photos refuses before anything is sent, and the Anthropic client is never created.

Invariants, checked in CI (the definition of done):

- **Unchanged without imports.** With an empty library, the builder data (the SRD object itself), the
  rules index contents, an SRD character's sheet text, the DM system prompt and the DM request bodies
  are byte-identical to before (`src/dm/requestBytes.test.ts` pins the request bytes).
- **One deliberate `DM_TOOLS` change** in this release (above), reviewed with its cost; otherwise
  `DM_TOOLS` equals `src/dm/tools/__snapshots__/dm-tools.json` (25 tools, same order).
- **Privacy.** No marker sentence of the test book appears in any exported bundle (the e2e test). Every
  copy of book text onto a character carries an `ImportedRef`; exports replace that text with a
  placeholder, and a device that has the book fills it back in.
- **Records are the only structured state.** Nothing writes structure into `libraryEntries`: their one
  writer stays `saveLibrarySource` (the importer). Un-accepting, switching a book off or deleting it
  reverts every consumer by construction.
- **Extraction stays out of play.** It never touches a DM session, transcript, system prompt or
  `Campaign.usage`; it has its own ledger (`job.usage`, `record.extraction.usage`). Every request it
  sends is built in `src/dm/libraryRequests.ts` under CLAUDE.md rule 4, and none is sent in demo mode or
  without a key.
- **Layering.** `src/test/layering.test.ts` and `src/dm/requestAudit.test.ts` pass: `src/data` never
  imports `src/dm` (except `vision.ts` → the client and `libraryRequests`), nothing outside `src/ui`
  imports it, campaign exports and sync never import the pack module, the request leaves never import
  a barrel, the game store reaches `@/data` only dynamically, and the engine stays pure.
- **No file moves** except the four builder helpers (`classFeatures`, `featureUses`, `leveling`,
  `species`) that moved from `src/ui/builder` to `src/data/options`, each leaving a one-line re-export
  shim, so `src/dm` never imports `src/ui`.
- `npm run typecheck`, `npm test`, `npm run lint` and `npm run build` are green; no
  `dangerouslySetInnerHTML`; theme tokens only.

## Content & licensing

- Bundled rules: SRD 5.2.1, CC-BY-4.0. The attribution statement (in `SRD_ATTRIBUTION`) appears in
  the Library, the README, and ATTRIBUTION.md. Our JSON is a modified (converted) form of the SRD.
- Describe the app as "compatible with fifth edition"; never use Wizards' trademarks in branding.
- Imported content is stored only in IndexedDB on the player's device. Passages the DM looks up from
  imported books are wrapped in `<imported-content>` markers in tool results, and exports / GitHub
  saves redact them (src/lib/importedContent.ts); book text copied onto a character is replaced by a
  placeholder in exports (src/storage/redact.ts) and restored on a device that has the book; the DM's
  own narration may still paraphrase them.
  GitHub sync refuses public and internal repositories.
- One tab at a time per campaign: the play screen holds a Web Lock; a second tab offers "Use this tab
  instead".
- Production builds ship a Content Security Policy: the page talks only to itself,
  api.anthropic.com, api.github.com and api.openai.com (illustrations, only with the player's key).
