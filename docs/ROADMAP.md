# Roadmap

Ideas for after v0.1, roughly in order of how much they'd improve play. Each is a good size for one
vibe-coding session.

## Play experience

- **Party play**: a DM-run companion with its own sheet in the combat tracker, or a second player
  character the player controls.
- **Voice**: optional text-to-speech for narration and voice input for the composer.
- **Downtime and Bastions** (2024 DMG concepts, from the player's imported books): between-session
  activities the DM resolves with tools.
- **Session-zero chat**: a guided conversation that builds the character and campaign premise with the
  DM, as an alternative to the builder form.

## Rules depth

- **Spell effects**: concentration tracking on combatants, durations that tick down by round, and
  spell-based AC (Mage Armor, Shield of Faith).
- **Class extras**: Unarmored Movement, lineage spells gained at levels 3 and 5, and replacing
  "Action Surge (two uses)" / "Indomitable" entries in place at Fighter 13 and 17.
- **Level-up spell picks**: choosing new spells in the level-up dialog (ASI/feat, Epic Boon and Fighting
  Style choices and subclass catch-up are in), plus multiclass proficiency gains and features that pick
  more than one option.

## Memory and cost

- **Chronicle condensing**: summarize the oldest session recaps into chapters once the chronicle gets
  long, so the system prompt stays compact over very long campaigns.
- **Cache keep-alive**: an optional low-cost keep-alive for long pauses, instead of the 1-hour cache
  TTL, with a cost comparison in Settings.
- **Usage dashboard**: per-session and per-campaign token/cost history from the stored usage totals.

## Platform

- **Offline/PWA**: a service worker so the app (and demo mode) works offline; installable on phones.
- **More sync targets**: an export to Google Drive or a GitHub Gist alongside the private-repo sync.
- **End-to-end tests in CI**: run `e2e/` (demo flow + fake-API flow) on pull requests.

## Battle map follow-ups

The first battle map deliberately leaves these out (each has a documented stand-in today):

- **A map band on the phone's Story tab**, so you can read, move and type without switching tabs.
- **Drag-to-move and waypoints** for the player (the engine already supports `via`).
- **Squeezing** through narrow openings, **raised floors, stairs and climbing** terrain, **doors that open during
  movement**, and **hidden terrain** (secret doors, concealed pits).
- **Movement traits** (Flyby, Swarm, Incorporeal Movement and the like), **grappled dragging**, **mounted combat**.
- **Light and vision**: darkvision, dim light and fog of war on the map.
- **Background art** for maps and **hex grids**.
- **Companions the player moves** (today the DM moves allies).

## Structured imports follow-ups

The first version of structured imports deliberately leaves these out:

- **Cheaper bulk reading**: the Message Batches API (half price, asynchronous), several entries per request, and an
  exact token count before a job starts.
- **Finding what detection missed**: a Claude pass over entries the offline detector didn't recognize (today,
  "Structure as…" on the book page).
- **Editing a book's text** in the app, and re-importing a new copy of a book while keeping review decisions.
- **Per-campaign book selection** (today every switched-on book applies to every campaign).
- **Item mechanics**: a magic weapon's +N on attacks (the DM adds it: a book weapon's is tagged "not counted by the
  app" on the DM's sheet, an SRD "+1 Longsword" carries no numbers to tag), charges, spell attack and save DC bonuses
  from items, and enforcing attunement limits.
- **Monster detail**: structured actions and legendary actions, and senses on the battle map (the DM reads them from
  the text today).
- **Book text the DM repeats elsewhere**: the book's words in the journal, quests, recaps or narration, in a feature
  the DM names otherwise than the book does, or in a quote shorter than about 80 characters among the DM's own words
  (a text under 60 characters counts only when its first 40 are the book's) aren't marked as copied, so exports keep
  them; nor is text written before this version. Spell notes, item descriptions, refused calls and calls whose text
  has left the sheet are covered.

Known limits of the offline reader (the book page's *Structure as…* and a Claude reading cover each). The magic-item
bonus reader is frozen except for outright bugs: the misjudged shapes below stay, and the DM honors a condition from
the item's text, since the sheet names the item behind each AC and save bonus:

- **Converter layouts read as rules on a fresh import** (kept when an earlier version stored them): web pages' spell
  cards in divs converted by pandoc's gfm or commonmark writer, a card outside a table with pipes, a GFM table with no
  delimiter row, single-spell tables whose name cell differs from the heading, pandoc grid tables, and pandoc simple
  tables whose header is centered or right-aligned (some long casting times).
- **Word documents converted by pandoc**: the text after a multiline table can become an entry of its own, named
  after the table's last row.
- **Paste with formatting** (the box's text can be edited before the import): a heading inside a sidebar or an
  infobox (an `<aside>`) opens a section that takes in the text after the box; a page's quick menu, pager and "Back
  to Top" links inside its main content stay; a table's second header row reads as its first body row; a spell's label
  and value in separate boxes ("Casting Time" over "1 Action") aren't joined; text laid out by CSS alone (`display:
  block` or `flex` on spans) runs together; and a line of the plain text that starts with "# " (a "#" column) pastes
  the whole copy as plain text.
- **Homebrewery and 5etools stat blocks**: creatures made with Homebrewery's V3 snippet ("**Armor Class** :: 13")
  read as rules, and a 5etools or legacy Homebrewery export that quotes each stat block (">## Name") merges its
  creatures into one entry.
- **Creature parts filed apart**: when a creature's or NPC's own text shows no AC and HP lines or ability scores (its
  stats in a section of their own, or "uses the … stat block, with these changes:"), its Actions, Bonus Actions,
  Reactions or Legendary Actions become entries of their own if they print no stat-block notation, or if each action
  is a heading of its own.
- **PDF heading sizes out of the usual order**: a stat block's part headings set larger than the creature's name (as
  Word's small-capitals effect can make them) take in the next creature; a heading that wraps onto a line set smaller
  (a tagline, or a small-capitals line of figures) is named by that line; and a sidebar's, table's or running header's
  title set between the book's heading sizes, or a stat block the reader doesn't recognise (AC and HP without a
  challenge rating or ability scores), becomes the parent of the entries after it (their paths only).
- **A rules chapter's "Traits"**: a section named "Traits" stays in the section above with its sub-sections, as a
  species' traits do, so example traits under a stat-block chapter's "Traits" aren't entries of their own.
- **Stored misreadings kept**: a glossary or a blank card that lists only a spell card's labels, a rules section that
  ends in a bare list of them ("Reading a Spell"), and a web page's glossary in divs or spans whose Casting Time
  definition opens with a casting time, stay spells when the first release stored them as spells (a PDF reader's copy
  of a real card's label column looks the same, and keeping a misreading is the safer side).
- **Spell cards read as rules**: a pandoc table under a header a key/value card doesn't use ("Field | Description",
  "Property | Setting", a first row that isn't a card field, a blank or extra header cell), and a PDF viewer's copy
  of a two-column card table that lost its value column (its labels over the spell's prose).
- **Magic-item bonuses applied that hold only sometimes** (the reader can't see the condition): a condition stated
  only in a table, a sidebar or another entry; a sentence a PDF cut at its end, before a capitalised sentence of its
  own; a wrapped Markdown line that starts with "- " ("…a +1 bonus to Armor Class" / "- but only while…"); a
  restrictive "that" after the item ("This is a cloak that works only at night."); a condition inside an earlier
  clause of a sentence whose always-on opening governs the bonus ("While you wear this cloak, your outline blurs in
  Dim Light, and you have…"); a sub-heading or bold line inside a failing heading's section, which ends that
  heading's reach (headings' levels aren't kept); a heading or bold line that names a condition the label lists
  don't know ("**Wild Shape:**", "#### Wild Shape"); a bold no-armor line that a PDF text layer joins to the next
  paragraph (its AC bonus counts in armor); a reference to an effect, a property or a pronoun after a flavor sentence
  ("The ward glows. It ends when you are Bloodied."), which limits only its own paragraph; a reuse limit joined to a
  restriction of the item itself ("…the cloak stops working, after which it can't be used again…"); a leading
  condition carried across ", and", ", but" or ";" ("If the cloak gets wet, its hem darkens, and it becomes
  powerless."); a run-in label ending in "." over a bare state ("Night. The cloak is inert."); "For this cloak to
  work, you must be underwater."; "It is said that the cloak works only for elves."; "You can use it only at
  night."; an elliptical second clause ("Other creatures gain no benefit from the cloak, and you gain none while
  raging."); a PDF column break right before a reference sentence; and "doesn't help you hit Constructs" or
  "becomes no more than an inert scrap of cloth".
- **Magic-item bonuses noted though they always hold** (the reader fails closed): a negated verb beside a condition
  word that limits nothing ("The cloak doesn't glow in sunlight."), double negations ("…doesn't stop working while
  you sleep"), a few wordings that name the item in an aside, a label or a "the <noun>" before a negated verb
  ("The clasp doesn't work loose."), lead-ins stacked after an always-on opening ("for as long as you wear it,",
  "without fail,", "at once,", "over time,"), a sentence about the item for someone else or before attunement ("For
  anyone else, the cloak functions as a nonmagical cloak."), uses that may come back ("Once its uses are spent, the
  cloak becomes useless."), "choose one of the spell's effects", "choose one of the following bonuses" offering
  other bonuses after an always-on one, "Nothing short of a Wish spell can strip the cloak of its magic", "Only
  magic can suppress the cloak.", "_**Weakness:**_ The cloak becomes useless.", "If one of the rings in a pair is
  destroyed, the other ring becomes nonmagical.", colon lines that name what follows but aren't on the offer list
  ("Bonuses:", "Passive Benefits:", "Stats:", "Notes:"), a heading's paragraph after an always-on bonus that says
  when its own effect ends, and an always-on run-in after a closing paragraph under a heading, bold line or intro
  that fails or sets the no-armor condition.
