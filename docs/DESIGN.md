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

**The hero's sheet** (`characterSheetText`, src/engine/summary.ts) is one rendering for the frozen
prompt's snapshot and `get_character_sheet`. The numbers are compact; every text is whole: what the
player wrote (traits, ideals, bonds, flaws, appearance, backstory, notes), each feature's rules text, a
transformation's summary and way back, the description of an item no rules entry describes (a custom
item, or the DM's words on a book's item, wrapped like copied text) and a spell's notes (the DM's, or the
builder's on a feat's or species' spell). Numbers name their sources where a condition may matter: the AC formula
names each item it counts, the Saving throws line what every save includes (`saveBonusSources`: a Ring or Cloak of
Protection, an item's bonus the app read as always on, Aura of Protection), and an active item's attack and damage
bonuses, which the engine doesn't add, are tagged "not counted by the app". The DM instructions ("Bonuses") say
the app counts only what the sheet names (attack ability and proficiency, the AC formula, the Saving throws line, the
Defenses line, the Advantage sources the Advantage line lists) and leave the rest to the DM: cover, a fighting style,
a spell such as Bless, and for items a bonus an item's text gives only sometimes, a condition that stops a counted one, those
attack and damage bonuses, and any bonus of an SRD or homebrew item (the app reads no text there; it counts only the
Ring and Cloak of Protection, Bracers of Defense and a "+N" armor or shield by name), applied by adjusting the AC or
DC it passes (extra damage goes in the damage roll's `expression`; a die such as Bless's is rolled first) and told to
the player in a line; the order of truth says an item's own text (or a recorded ruling) beats a number the app worked
out from it, and the player's inventory says the DM adds those bonuses, so nobody adds them twice. An AC the DM sets
by hand (`armor_class`, for Mage Armor) gets the formula "set by the DM: <reason>" rather than keeping the old one's
items, and a change in what every save includes is announced in the tool's result and in the player's equip and
attune notices ("saving throws now include …"), since the frozen sheet's line dates from the start of the session.
Paragraphs and lists are kept and indented under their bullet; a Markdown heading inside a field
becomes a bold line, so it can't pass for a section of the sheet. A field is cut only past 20,000
characters (`SHEET_TEXT_MAX`, far above any real sheet: the longest SRD feature is about 4,300, Wizard
Spellcasting, and a level-20 SRD character's features 8,000–15,000 in all), at a paragraph, line or word
end and never inside an emoji; the sheet then says how many characters it left out, and to ask the player
(for book text: to rule from what is there or read the entry); a cut inside a book passage a field quotes
closes its wrapper, so a copy leaves out that passage only. The sheet's text boxes tell the player when the
sheet would cut a field, measured as the sheet measures it. Edits mid-session reach the DM as one-line notices (they are parsed back line
by line): a personality or notes edit quotes its opening and points to `get_character_sheet` for the
whole text, as do a details edit and a rebuild. Every cut the DM's text goes through (notices, journal
lines, cards, memory excerpts, rules excerpts, refused-call previews, the sheet) ends at a whole character,
so no request carries half an emoji, and closes a wrapper it cuts inside. A journal line cut at 300
characters points to `search_memory`, which puts an entry whose name the query is (case and spacing aside)
first and whole.

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

**Detection rules.** Entry kinds are guessed at import (`guessKind`, `src/data/chunk.ts`) from an entry's own
lines, never from mentions in prose. Headings don't decide a kind, because PDF, photo and pasted-text imports often
lose or merge them.

- **Feats**: a category line ("General Feat (Prerequisite: Level 4+)", also when a PDF or pasted text joined it to
  the feat's first sentence or wrapped it), a name that says so, or a bare "Prerequisite:" line before the text,
  which is how older books print feats. Books print other things that way too, so a bare Prerequisite line doesn't
  make a feat when the entry shows a shape such things print and feats don't: a type line before it (a stronghold
  room's "Level 5 … Room", a class option's "Eldritch Invocation"), a prerequisite naming a class at a level, a
  warlock pact, a cantrip or a patron ("Level 5+ Warlock", "ember dart cantrip"), labelled lines after it ("Item: A
  pair of boots", "Space: Roomy", or such a label joined into the Prerequisite line), or a heading above it that
  names invocations or infusions. A level alone ("4th Level") and "Prerequisite: None" are not signs: feats print
  them too. Only the prerequisite itself is read, not the feat's first sentence a PDF joined to its line, and a web
  copy's "Source:" line never counts. Under a heading that names feats, a Prerequisite line always counts.
- **Magic items**: a type line that starts with its category (perhaps after a "Type:" label, a table cell, or the
  item's name and a dash or parenthesis) and names a rarity. It is checked first, so an item that mentions a cantrip
  stays an item.
- **Monsters**: AC and HP lines with a CR and its XP, or the six ability scores. A stat block's "Actions" and the
  like follow the creature before them when a PDF puts them at its heading level.
- **Spells**: a level and school line, a "Casting Time:" label, or a spell card's labels without colons at the top
  of the entry. A card is labels alone over their values, or a run of labels over a run of values (a web grid
  copied as text, but not a run whose Name or Spell label holds another spell's name); a grid's row of labels,
  Casting Time first, over its row of values ("CASTING TIME RANGE" / "1 action 120 feet"); a label set off from its
  value by a tab, spaces or a dash ("—", "–", "--", pandoc's "---"), or by one space after a bold label or a PDF's
  label run; a one-row table under its labels; or a table of label/value pairs, two or four columns, whose every row
  is a card field. A table is a Markdown pipe table, one pasted as text, or one of pandoc's own (a simple table: a
  header over a rule of each column's dashes; a multiline table: between two rules across), read by its rule's
  column positions, a merged title row over the labels counting as a caption. A pandoc table that isn't a card that
  way is still read row by row ("Casting Time   1 action" under a "Property   Value" header) when its header is one
  a key/value card has (a values column, "Property | Value" or "Attribute | Info"; the spell's name; or one of the
  card's own rows), its cells read without emphasis (a bold header row, a Word table's bold label column), not a
  table that compares spells or modes ("| Ember Lash | Glow Mote", "Normal casting | As a ritual") or says what
  each field means, holds or defaults to ("Field | Meaning", "Field | Example"). pandoc's grid tables aren't read.

Before a card is read, converter marks go: hard-break backslashes and `<br>`, Markdown escapes, and any run of quote
marks and bullets a line opens with (a callout's "> - ", ● ■ ◆ ► ▪ • · U+F0B7, and - + – — before a space). Any space
a converter writes (no-break, en, em, thin, hair, figure, narrow no-break, ideographic, or its HTML reference) reads
as a space, and characters that show nothing are dropped. Casting Time's value must be one spell's casting time
(Action, Bonus Action, Magic action, Reaction, N minutes or hours…, "Action or 8 hours", "1 minute or Ritual"), not a
page number, "Varies", a definition, or a list of the casting times spells can have: two with a comma between them,
or "or longer", anywhere in the value's own words (up to the card's next label on its line, a reaction's ", which
you take …" trigger left out); "or more" counts only right after the casting times. So neither an index nor a
glossary is a card, and a rules section that opens with such a glossary keeps its subsections as rule entries. A
feat or an item that prints the card of a spell it grants or casts stays a feat or an item (its category or type
line anywhere above the card, or a Prerequisite line above it); a creature or feat that prints a table of spells
stays what it is; a summoning spell is read before the stat block it prints. A section that reads as a spell but
has subsections that read as spells is a chapter: its own text is an entry, read as whatever it reads as, and each
subsection is an entry. Other entities keep their subsections (a creature its Variant stat block, a summoning spell
its creature). Pasted text never takes for a heading a table's row (any line with "|"), a card label over its
value, a label set off from its value, or "Origin Feat".

**PDF import** (`src/data/pdfLayout.ts`) drops a repeated line as a running header only where it stands at the top
or bottom of its page, and never a stat block's line, an item's type line, a feat's category line, a labelled line
in body text such as "Casting Time:", or a line that starts with a spell card's label set at 70% of the body size or
more (in any case, with or without a bullet or a colon); a chapter header such as "Appendix B: Magic Items" still
goes. A feat's category line keeps its own line, and a line of card labels alone (one label, or a grid's row of
them) is a paragraph of its own.

**Magic items** (`src/data/structured/parse/magicItem.ts`). A type line is read by its own grammar: a category,
then rarities joined by "or", each with its parentheticals (attunement among them), also when wrapped over two
lines, and cut only where a PDF joined prose onto it. Variants start at a "Name (Rarity)." run-in, or at the same
name as a heading, bold line or PDF line; a variant's text runs to the next variant or to a paragraph about the whole
item ("Each such cloak…", "These cloaks…" after the last variant), and its bonuses and charges are its own.

A +N bonus to AC, saving throws, attack rolls or damage rolls is applied only when the text says it always holds:
the item worn, held, carried or attuned. Anything else is left out with a note ("…holds only in some situations, so
the app doesn't apply it (the DM can)"), and a Claude reading that applies such a bonus gets "…check it". The
reader fails closed, so a shape it can't read is noted rather than applied: a conditional bonus applied silently
changes combat without the player knowing, while an always-on bonus left out shows its note and the DM can still
apply it. **The reader is frozen**: it changes only for outright bugs (a crash, a hang, a bonus taken from another
item or sentence, a note that misstates what the app applies), not to learn more wordings. A condition it misses is
the DM's to honor, from the sheet's named sources and the item's text (see "The hero's sheet" above), and ROADMAP.md
lists the shapes it is known to misjudge. It reads the item's own name with it, and judges:

- **Paragraphs.** List items, headings and bold-only label lines are paragraphs of their own. A paragraph with no
  closing punctuation goes on into the next when that one starts in lower case, with "(" or a dash, or when the
  first ends where a sentence can't (an article, a preposition, "you", "+N", a comma…), never into a heading, a
  table, a list item, a type line or a variant, nor after a ":". A bullet a PDF column cut off starts its list item
  again; a sentence still cut at a paragraph's end is noted.
- **Labels and intros.** A run-in label fails on "Only", a parenthesis, a condition, or a place, state or time word,
  and then governs the rest of its paragraph; one that is an always-on or no-armor phrase ("While Attuned", "While
  Wearing This Cloak") holds. An intro (a last sentence ending in ":", or one that offers "the following…", "these
  benefits", "as follows") offers the run-ins and list items after it, and governs them when it fails. A paragraph
  that is only a label and its ":" holds only when the label names what follows ("Benefits:", "Magical
  Properties:", "Its Powers:") or is an always-on or no-armor phrase ("While attuned:", "No Armor:"); any other
  ("Wild Shape:", "While raging:") is an intro that fails. A paragraph that is only a label (a heading, a bold line,
  a label a PDF column ended after) governs as an intro does, up to the next label-only paragraph or variant; a
  label alone ending in "." (a run-in label a column ended after) governs only its own text, up to the next run-in,
  while a heading or bold line keeps its range even where flattened text prints it plain. A failing label's or
  intro's range, and a no-armor one's, goes on past plain paragraphs that a list item or run-in follows (a list
  item's or run-in's second paragraph; a Homebrewery `\column` or `\page`, `---`, an image, an HTML comment,
  `{{note}}`, `<br>` or `&nbsp;` line between bullets), up to the next intro, label-only paragraph, variant or
  paragraph about the whole item. A label or intro that holds by the no-armor condition gives the AC bonuses it
  governs `acOnlyWhen` ("no-armor", "no-armor-no-shield") and leaves their other targets out. A choice never holds
  ("choose one of these bonuses", "choose one of the listed bonuses", "choose one of the following bonuses",
  "alternatively…", "…instead"); "choose one of the following/below" properties, powers or the like offers what
  follows, and leaves an always-on bonus before it applied.
- **The bonus's own sentence.** Everything between a clause's start and its subject is its lead-in, and holds only
  as an always-on or no-armor phrase, a body place ("In your hands"), a connective, or a concession with no
  condition word ("even if/when/while…", "even in/at/during…", "even underwater", "whether or not", "regardless
  of", "no matter", "at all times", "in any light"). A colon run-in label before the subject is judged as a label:
  one that holds ("Stealth:", "Care:", "Lore:") is dropped and the sentence judged on its own; one that doesn't
  stays its lead-in. An
  opening (a preposition or subordinator, "Each night,", an inversion such as "Should you…") governs every later
  clause with no lead-in of its own, and each further lead-in after its comma is judged on its own. The bonus is
  yours, the wearer's, or the item's to give; anything else is another creature's and is noted. Only always-on
  phrases, "made with this weapon" and more benefits may follow the bonus: words after the clause's last benefit
  belong to the whole clause ("…and Resistance to Cold damage between dusk and dawn" leaves the AC bonus out too),
  and a bonus joined by "or", or under "either" or "your choice of", is a choice.
- **Limits elsewhere.** A restriction of the item in any main clause of any sentence leaves out every bonus of the
  item (or of its variant): the item as subject (by name, "it", "this <noun>", "the item", perhaps with an aside or
  a second subject before its verb), with a negated verb and a condition, "only" beside a works-verb, a negated
  work or function, a negated protect, help, apply or extend with a condition, "only", or a scope of attacks, hits,
  rolls, saves, spells or a kind of creature ("doesn't protect you from ranged attacks"; a damage type is no scope),
  a failure to work, or a state ("is powerless", "becomes inert", "functions as" or "is treated as a nonmagical
  cloak", with up to three adverbs before the state word: "is magically inert", "is all but useless"; also after a
  colon run-in label that isn't an always-on phrase: "Daytime: The cloak is inert."); or the item as object
  ("Sunlight renders the cloak powerless", "Only sunlight renders…", "Only fire magic renders…", and the
  wearer gaining no benefit from it however the wearer is named: "you", "the wearer", "its bearer", "a creature
  wearing it"). When no subject is found, a clause that names the item before such a predicate is a restriction
  too, its own noun or kind after a preposition included ("A cloak of this kind works only at night", "The threads
  of this cloak unravel…"), and so is "only" up to three words after a works-verb ("…protects you only from
  arrows"). The item's magic or protection as a
  subject ("The cloak's magic fails in sunlight, but…") restricts the item. A reference back to a bonus ("the bonus",
  "this benefit", "these properties", "it") limits it with a condition word, a negation of its working, or a limit
  word; a limit covers its paragraph, what an intro there offers, and the paragraph before it when the limit opens
  its paragraph or, in a paragraph with no bonus of its own, is a reference to a bonus anywhere in it (in a plain
  paragraph, to a benefit, a protection or a ward too), stepping over headings. A reference to an effect, a
  property or a pronoun later in such a paragraph is that paragraph's own and reaches no further (SRD Cloak of
  Invisibility's "The effect ends early if…", Cloak of Displacement's "…the property ceases to function…"). When
  armor worn is the only condition, the AC bonus gets `acOnlyWhen` and the other targets are left out.
- **What limits nothing**, judged per main clause so the clauses beside it are still read: a reuse limit ("can't be
  used again until…"), cut from a limit it is joined to (at ", after which", ", at which point", ", whereupon",
  "and (then) can't be used", or after a ", which …," aside) so that limit is still read; a permanent loss
  ("becomes a nonmagical cloak", "is destroyed", or after a bare use count: "After the tenth time, it cracks and
  becomes useless") where a loss in a place, time or state is a restriction, and so is one after uses that may come
  back ("Once its uses are spent…"); "can't be suppressed", "doesn't stack", "increases to +N", examples and table
  cells; the item only as a preposition's object ("in excess of this number") or inside a leading "If…" clause
  whose main clause is about the other one ("If one of the stones in a pair is destroyed, the other one becomes
  nonmagical.", though a later part of that main clause about the item still counts: "…, the other properties stop
  working and the cloak becomes powerless."); what other creatures gain ("Other creatures gain no benefit from the
  cloak", "A thief gains no benefit…") and what nothing short of a Wish spell, a deity, divine magic or an artifact
  can do ("No mortal magic can render the cloak powerless", "Only a Wish spell can render it inert"); "only" away
  from a works-verb or a condition ("…forged this armor only for
  their kings"); and a spell's, effect's or part's own failing ("the spell doesn't work on Undead", "The strap
  doesn't work loose").
- **Claude readings** get "check it" for a bonus whenever the offline reader doesn't read the same always-on value
  for that target, and an AC bonus whose `acOnlyWhen` differs from the text's condition is noted.
- **Speed.** No regex has nested or overlapping quantifiers, cheap word tests run before costly patterns, and every
  pass is linear in the item's paragraphs; caps fail closed (a sentence with more than 24 bonus phrases is noted, a
  clause with more than 64 places a subject could start is a restriction). Pathological items read in under 100 ms,
  and the whole SRD chapter as one entry in about 60 ms.

**Correcting stored kinds** (`src/data/structured/staleKinds.ts`). Kinds are guessed once, at import. After
startup and before each look through a book, the app corrects the kinds an earlier version stored for entries it
now reads differently: a frozen copy of the first release's rules (`guessKindV1`) recognises what that version
stored, and `misreadBefore` asks whether today's rules read the entry as something else. Only guessed kinds are
corrected: imported text, and "Download book data" files of it, which say so (`kindsGuessed`; a file from a
version that didn't write it is judged by its `bookFingerprint`). An authored JSON file's kinds are its own on every
device, and so are those of a JSON book already in the Library from before `kindsGuessed` was recorded: nothing
tells it apart from an authored one (its book data says `kindsGuessed: false`). A safety net keeps what the first release stored in a shape today's rules don't read whole, because a kept
misreading is the safer side:

- A stored spell is kept when one of its first 16 lines with text (converter marks gone; spaces and their
  references as spaces; links' targets and pandoc spans' attributes dropped, their text and HTML tags' place set off
  by spaces, so "**Casting Time**[Action]{.value}" is a label and its value, but not from a colon or comma after
  them, so "[Casting Time](…):" is "Casting Time:") opens with "Casting Time" after any marks, as the first
  release's test read it, and a casting time stands in its value's place: later on
  that line, past marks, short tags ("(R)", "(ritual)", "(C)") and the card's other labels and fields ("| Casting
  Time | 1 action |", "**Casting Time** (R) 1 minute", a PDF's "CASTING TIME RANGE SCHOOL 1 action 60 feet
  Evocation"); or, when the rest of the line holds only marks, tags, labels and fields (not a column of names), at
  the start of the first line below it that doesn't only draw the table (delimiter rows, pandoc's rules, grid
  borders, fenced-div fences, Org rules, spacer rows and thematic breaks are skipped), or of the line above it (a
  value printed over its label; the entry's name when the label opens the text), or nowhere at all (the label row
  ends the entry's text, or only more lone labels follow it, as when a PDF reader copied a card table's label
  column and the values went to the next entry, whatever stands above them: a Source, Classes or school line, a
  tagline, the previous spell's prose in a copy without headings; so a section's prose over a bare list of the
  labels stays a stored spell, the lesser harm). A run of labels over their values, and a card's table, count too,
  unless the entry opens with a creature's size line.
- A stored magic item is kept when its first two lines print a category (and its parenthetical) and then a rarity:
  after a comma or another separator (";", "/", "|", "·", "•", "—", "–", " - ", pandoc's "--" and "---"), perhaps
  labelled "Rarity:"; after a "Rarity:" label; or in parentheses ("Item Type: Wondrous Item / Rarity: Rare", "Magic
  Item: Armor (Plate) (Uncommon)").
- Still corrected: feats and items that print a granted spell's card, an index's page numbers, a glossary's
  definitions, "Varies", a contents page, a web grid's list of spells, prose about rare armor, "Magic Item Values by
  Rarity", and the first release's "feats" that were rooms, invocations or other class options.

A look through the book uses today's kinds even when that correction couldn't be stored, and an open book page reads
its entries again after one.

**Re-check.** When the offline rules change, `PARSER_VERSION` rises and the book page offers *Re-check for free*, which
looks through the book again (`detectStructure`). It settles only the misreadings the version change
explains (an entry an earlier version took for a spell, monster, magic item or feat that today's rules
read as something else), judged by the entry's text, not by the version a record carries: removed when
nobody worked on them, kept with a note once when someone accepted, edited, re-read with Claude or has a
newer reading waiting, and accepted ones go back to review. A record that already has that note is the
player's to decide, and the entry the player has open is never removed (it gets the note). *Re-read on
this device* gives such a record the note instead of reading it again as its old kind, and moves an
accepted one back to review, as Re-check does. Records waiting in a paused Claude job are read again like
any other (their place in the queue is kept); a note takes a record out of the queue, wherever it comes
from (Undo included), the runner never reads a record taken out of its queue, and the paused job is
recounted, so Resume never pays to read a misreading. A job that is reading, or paused only until another
tab lets go or the connection returns, keeps its queue. Undo accepts the moved records again and puts back
the removed ones with the note, never over a record made again meanwhile; its toast stays longer for a
long message and while the pointer rests on it, and the DM hears of an accept only once its Undo is gone. Records the player marked (*Structure as…*, *What it is*)
are never removed, only read again. A look through the book reads the records first and writes at the
end, skipping any record that changed meanwhile (an accept, an edit, a Claude reading). It offers an
offline reading as a "newer reading" only when the reader's reading changed since the record was last
read (`readingHash`), and never over the player's edit merely because the edit differs. No offline
reading, asked for or not, ever replaces a Claude reading waiting as a proposal. Stale text is judged on a
record's own entries. A subclass that takes the feature headings a PDF flattened beside it stops at a
sibling that opens with a Prerequisite line (a class option).

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

**Storage** (Dexie version 3, `src/storage/structured.ts`): `libraryRecords` (one row per record, with
the run state of the latest job that touched it) and `libraryJobs`. Neither is part of
`campaignTables()`: like the library, they never leave the device. Every record write keeps the book's
denormalized counts (`LibrarySource.structure`) right in the same transaction; deleting a book removes
its records and jobs and is refused while a job runs.

**Records beside entries.** Nothing writes structure into `libraryEntries` (staleKinds.ts only corrects
kinds the import itself had guessed). `getLibrarySnapshot()` reads
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
The sheet text wraps each copied description whole, as one passage (cut only past `SHEET_TEXT_MAX`,
with the note outside the wrapper), so the DM's frozen prompt can be redacted whole; a wrapper left open
(its closing marker cut off) is redacted to the end of its text. A feature the DM adds under the name of
one of the book's parts or feats (`features_add`, `level_up` extras) gets that part's ref when its
description repeats the part's words (a 40-character run), unless the SRD prints the same name; the DM's
own words under such a name stay its own, so exports keep them and restore never writes the book's text
over them. A spell's notes (`spells_add`) or an item's description (`inventory_add`, `inventory_update`) that repeats
a book's spell or item (either way round: a scroll quoting a spell, notes quoting an item), whatever name it is
given, takes that entry's ref marked copied: two of those 40-character runs (the only one, in a text under 60
characters) found in one entry's own words — not in the SRD's text of any kind, whose words are anyone's to keep,
and not stock wording the books print under several names — compared with typographic quotes and dashes made plain.
A quote shorter than about 80 characters inside the DM's own words can escape (one aligned run), as can a text
written before this version. The sheet then wraps the text and exports replace it, as for the book's own item,
while the DM's own notes stay its own (the check reads the book text, joined once per rules index: about 70 ms for a
few large books, then milliseconds a call); a spell re-added without notes keeps its notes' mark. On the player's
inventory such a ref only marks the words: an SRD or homebrew item still shows its own entry. While a book is in play
(a ref on the sheet, or a book passage in the transcript), exports also replace every text field and long string of
a call the app refused, whatever the tool, as the refusal's preview quotes them, and a description or note in an
earlier call that the sheet no longer holds under that name (removed, renamed, stacked or rewritten). A memory excerpt (`search_memory`) that starts inside a quoted book passage opens its wrapper again. A `level_up` extra naming a copied feature the sheet already has (a name the SRD doesn't print)
adds no second copy, and the result says it was kept as it is; and a call the schema refuses quotes every
text field (and any long string) by its length, never its words.
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
  are byte-identical to before (`src/dm/requestBytes.test.ts` pins the request bytes). The sheet has
  since carried long text whole (above); a sheet whose texts are all one line and within the old
  limits reads byte for byte as before (`sheet-srd-character.md`). The DM instructions have since gained the
  "Bonuses" line (and its exceptions in the order of truth and table talk), an exact Advantage line (what the app
  applies to the hero's rolls; cover isn't Advantage), free castings and rituals beside spell slots, extra damage in a
  sheet attack's `expression`, damage to the hero passed before the Defenses line's resistances, item charges kept as
  a feature with uses, rulings that name an item, rulings kept when homebrew is off, and a missed tool call made late
  and said aloud; and the Saving throws line names what every save includes (a Ring or Cloak of Protection, Aura of
  Protection), so those sheets and the prompt differ.
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
