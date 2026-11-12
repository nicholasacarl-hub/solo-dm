# Solo DM packs (`solo-dm-pack`, version 1)

A pack is a JSON file that carries rules text **and** the structured data the app uses for it: the
numbers of a stat block, a spell's level and area, a subclass's features. Importing one adds a book to
the player's Library (on that device only) and puts its records on the book page for review, exactly as
if the app had read the book itself. Nothing in a pack is used until the player accepts it.

Two kinds of files use this format:

- **Packs you write or share**: your own homebrew, or content whose license allows it. Use only text you
  have the right to share.
- **"Download book data"** (the book page's ⋯ menu): a personal copy of one of your imported books with
  your review decisions, to move it to another of your devices without structuring it again. It
  contains the book's full text — keep it for yourself. It is never part of campaign saves or GitHub
  backups. A book that came to a device as JSON before the app recorded where its kinds came from keeps
  them as they are, and its book data says `kindsGuessed: false`; to have a text book's kinds corrected
  there, download its book data again from the device that imported the text, and import that.

Older JSON imports (a plain array of entries, or `{ "entries": [...] }`) still work as before; only a
file with `"format": "solo-dm-pack"` is read as a pack.

## The file

| Field | Required | What it is |
|---|---|---|
| `format` | yes | `"solo-dm-pack"` |
| `version` | yes | `1` (a newer number means a newer app made it: update first) |
| `schemaVersion` | yes | `1`: the version of the records' `data` |
| `title` | yes | The book's title in the Library |
| `license`, `attribution`, `notes` | no | Shown on the book's Library row |
| `bookFingerprint` | no | Book-data files only: identifies the book the file was made from |
| `kindsGuessed` | no | Book-data files only, written whenever `bookFingerprint` is: `true` when the entries' kinds are the app's guesses (the book was imported as text), so a later version may correct the ones it misread; `false` when they are its file's own (a JSON import). A book-data file without it is read as `true` |
| `entries` | yes | The text, one entry per heading section (1–10,000) |
| `records` | no | Structured data for some entries (up to 5,000) |

Files over 20 MB are refused before they are read.

### Entries

```text
{ "id": "...", "name": "...", "kind": "spell", "summary": "...", "text": "Markdown", "path": ["Chapter", "Section"] }
```

- `id` is local to the file (any unique string). On import, entries are renumbered
  `lib:<new book id>:1`, `:2`, … in file order.
- `kind` is optional (`rule`, `condition`, `spell`, `monster`, `magic-item`, `item`, `feat`, `class`,
  `subclass`, `species`, `background`, `boon`, `other`); when it is missing the app guesses it as it does
  for imported text.
- `text` is Markdown. The DM can look every entry up during play, structured or not.
- An entry that can't be read fails the whole file, with the reason.

### Records

```text
{ "kind": "spell", "name": "...", "entries": ["entry id", ...], "span": "entry", "rowIndex": 0,
  "parentClass": "Fighter", "data": { ... }, "reviewedStatus": "pending" }
```

| Field | What it is |
|---|---|
| `kind` | `class`, `subclass`, `species`, `background`, `feat`, `spell`, `magic-item`, `item` or `monster` |
| `name` | The name the builder, combat and the DM use |
| `entries` | The file's entry ids it was read from, primary first |
| `span` | `entry` (default for one entry), `section` (default for several: a class, a species…) or `row` (one row of a gear table, with `rowIndex`) |
| `parentClass` | Subclasses: the class it attaches to — a class record's name in this file, or an SRD class name |
| `data` | The structured fields of the kind (below), validated with the same rules as the app's own reads |
| `reviewedStatus` | Book-data files only: `accepted` or `pending` on the device that made the file |

**Text spans.** Features, traits, lineages, a background's feature and a feat's text point at the
book's words instead of copying them. A span is either

- `{ "entries": ["entry id"], "from": 2, "to": 3 }` — paragraphs 2 to 3 (1-based, inclusive) of those
  entries joined (each list item and table row counts as one paragraph), or
- a plain string — the text itself, which becomes an entry of its own.

**Every record arrives pending.** The import's done page offers *Accept the N confident* (one tap); a
book-data file adds an unticked *Also accept the N you accepted on your other device*. A record that
fails validation is skipped and listed (the first 20 issues; the book's Library row says how many), and
the rest import. Ranges match what the app's engine and the DM's tools accept: AC 1–40, HP 1–2000,
initiative −10 to 20, reach 5–60 feet, ability scores 1–30, spell levels 0–9, a class level table of
exactly 20 rows.

### `data` by kind

The field names are those of `src/types/structured.ts` (`MonsterData`, `SpellData`, `MagicItemData`,
`ItemData`, `FeatData`, `SpeciesData`, `BackgroundData`, `ClassData`, `SubclassData`); every kind has a
`format` of `"2024"`, `"2014"` or `"other"`. Unknown fields are refused, so a typo shows up as an issue
instead of being ignored.

## Example

An invented pack (written for this documentation; it is checked by `src/data/structured/packs.test.ts`):

```json
{
  "format": "solo-dm-pack",
  "version": 1,
  "schemaVersion": 1,
  "title": "The Lantern Road (sample pack)",
  "license": "CC-BY-4.0",
  "attribution": "Written for the Solo DM documentation.",
  "entries": [
    {
      "id": "spark-lash",
      "name": "Spark Lash",
      "kind": "spell",
      "path": ["Spells", "Spark Lash"],
      "text": "_Level 1 Evocation (Sorcerer, Wizard)_\n\n- **Casting Time:** Action\n- **Range:** 30 feet\n- **Components:** V, S\n- **Duration:** Instantaneous\n\nA whip of sparks cracks toward a creature you can see within range. Make a ranged spell attack against the target. On a hit, the target takes 2d8 Lightning damage."
    },
    {
      "id": "road-warden",
      "name": "Road Warden",
      "kind": "feat",
      "path": ["Feats", "Road Warden"],
      "text": "_General Feat (Prerequisite: Level 4+)_\n\nYou know the old roads well. You have Advantage on Wisdom (Survival) checks made to follow a road, and you can't become lost while you follow one."
    },
    {
      "id": "lamp-keeper",
      "name": "Fighter Subclass: Lamp Keeper",
      "path": ["Character Options", "Fighter Subclass: Lamp Keeper"],
      "text": "_Keep the Road Lit_\n\nLamp Keepers guard the lanterns that line the old roads, and they fight best where the light is brightest."
    },
    {
      "id": "cinder-hound",
      "name": "Cinder Hound",
      "kind": "monster",
      "path": ["Bestiary", "Cinder Hound"],
      "text": "_Medium Elemental, Unaligned_\n\n- **AC** 13\n- **Initiative** +2 (12)\n- **HP** 22 (4d8 + 4)\n- **Speed** 40 ft.\n\n_**Bite.**_ _Melee Attack Roll:_ +4, reach 5 ft. _Hit:_ 7 (1d10 + 2) Fire damage."
    }
  ],
  "records": [
    {
      "kind": "spell",
      "name": "Spark Lash",
      "entries": ["spark-lash"],
      "data": {
        "format": "2024",
        "level": 1,
        "school": "Evocation",
        "classes": ["Sorcerer", "Wizard"],
        "ritual": false,
        "concentration": false,
        "castingTime": "Action",
        "range": "30 feet",
        "components": "V, S",
        "duration": "Instantaneous",
        "attack": "ranged",
        "damage": "2d8",
        "damageTypes": ["lightning"]
      }
    },
    {
      "kind": "feat",
      "name": "Road Warden",
      "entries": ["road-warden"],
      "data": {
        "format": "2024",
        "category": "general",
        "prerequisite": "Level 4+",
        "minLevel": 4,
        "repeatable": false,
        "text": { "entries": ["road-warden"], "from": 2, "to": 2 }
      }
    },
    {
      "kind": "subclass",
      "name": "Lamp Keeper",
      "entries": ["lamp-keeper"],
      "span": "section",
      "parentClass": "Fighter",
      "data": {
        "format": "2024",
        "parentClass": "Fighter",
        "summary": "Keep the Road Lit",
        "features": [
          { "level": 3, "name": "Steady Lamp", "text": "When you take the Attack action, you can also light or put out a lantern within 5 feet of you." },
          { "level": 7, "name": "Long Watch", "text": "You can't be surprised while you can see a lit lantern." }
        ]
      }
    },
    {
      "kind": "monster",
      "name": "Cinder Hound",
      "entries": ["cinder-hound"],
      "data": {
        "format": "2024",
        "size": "Medium",
        "type": "Elemental",
        "alignment": "Unaligned",
        "ac": 13,
        "hp": 22,
        "hitDice": "4d8 + 4",
        "speed": "40 ft.",
        "speeds": { "walk": 40 },
        "initiative": 2,
        "reachFt": 5,
        "cr": "1",
        "crValue": 1,
        "xp": 200,
        "pb": 2,
        "abilities": { "str": 14, "dex": 14, "con": 12, "int": 4, "wis": 12, "cha": 6 },
        "legendary": false
      }
    }
  ]
}
```

On import, *Spark Lash* and *Cinder Hound* are ready to accept; *Road Warden* points at the second
paragraph of its entry; *Lamp Keeper*'s two features become entries of their own and it attaches to the
SRD Fighter.
