# SRD 5.2.1 data sources

> Research notes gathered on 2026-11-06 while designing Solo DM. Sources are cited inline; verify before relying on them.

**SRD 5.2.1 source survey: recommendations (2026-11-06)**

**Recommendation**

- **Structured data: open5e/open5e-api.** Path: `data/v2/wizards-of-the-coast/srd-2024/*.json`. It is 33 Django fixture files, each a list of `{model, pk, fields}`. Child rows link to their parent through `fields.parent` or foreign keys. Lookup lists (sizes, languages, damage types, schools, conditions) live in `data/v2/open5e/core/`. I used branch `staging` at bdcddf2 (2026-11-02), and the repo is actively fixing srd-2024 data. It has the most mechanics already split into fields:
  - spells: save ability, area, damage, per-slot scaling
  - creatures: initiative and parsed attacks
  - classes: full level tables
  ```
  git clone --depth 1 --filter=blob:none --no-checkout https://github.com/open5e/open5e-api open5e-api
  cd open5e-api && git sparse-checkout set --no-cone /LICENSE.md /README.md /data/v2/License.json /data/v2/open5e/core/ /data/v2/wizards-of-the-coast/srd-2024/ /data/raw_sources/srd_5_2/ && git checkout
  ```
- **Rules prose: your5e/5e-srd-markdown**, `dnd/521/` at f1f5060.
  - `SRD_CC_v5.2.1.md`: one cleaned file, 1.66 MB, 13 chapters, 251 H2 and 1,399 H3 headings.
  - `markdown/`: 1,290 files, one topic each. Spells 339, Monsters 330 (animals included), Magic Items 258 plus rules pages, Glossary 155 plus an index, Classes 12, Species 9, Feats 17, Equipment 116, Playing 9, Gameplay 8, Character Creation 10. The 4 backgrounds are in `Backgrounds/Character Origins.md`.
  - The official `SRD_CC_v5.2.1.pdf` is included (sha256 8974902d…, the same file as Open5e's copy).
  - The text is a faithful 5.2.1 copy, keeps paragraph breaks, and has no HTML.
  ```
  git clone --depth 1 --filter=blob:none --no-checkout https://github.com/your5e/5e-srd-markdown your5e-srd-markdown
  cd your5e-srd-markdown && git sparse-checkout set --no-cone '/*.md' /dnd/521/ && git checkout
  ```
- **Optional cross-check: foundryvtt/dnd5e**, `packs/_source/{spells24,actors24,equipment24,classes24,origins24,feats24,content24,tables24,monsterfeatures24}/` (YAML, branch 6.1.x at ea442e3). It is the only structured source that is complete for 5.2.1, but its text is HTML full of Foundry template tags.

**What the official text contains.** I extracted text from the official PDF and counted: 339 spells and 330 bestiary stat blocks, plus 5 stat blocks embedded in spells or items. Compared with 5.2, version 5.2.1 adds the Octopus and 15 magic items: Bead of Nourishment, Cloak of Invisibility, Elixir of Health, Energy Bow, Gloves of Thievery, Hat of Many Spells, Potions of Invulnerability, Longevity and Vitality, Quarterstaff of the Acrobat, Rod of Resurrection, Sending Stones, Sentinel Shield, Shield of the Cavalier, Thunderous Greatclub.

**Counts by source**

| | Open5e srd-2024 | 5e-bits 2024 | Foundry *24 | your5e |
|---|---|---|---|---|
| Version | 5.2 plus some 5.2.1 fixes (has Octopus, lacks the 15 items) | 5.2 | 5.2.1 (its legal text still says 5.2) | 5.2.1 |
| Spells | 339 | 339 | 340 (adds Arcane Vigor, a non-SRD spell) | 339 |
| Creatures | 331 (330 + Giant Fly from the Figurine) | 341 (no Octopus; Vampire and 5 lycanthropes split into 18 form entries) | 380 NPCs (330 + 46 summon or spell-effect tokens; 4 duplicates) | 330 |
| Magic items | 243 base items as 760 variant rows; 4 base items filed in Item.json | 262 (243 + 19 variants) | 314 entries covering all 258 | 258 |
| Mundane gear | Item 203, Weapon 38, Armor 13, Service 30; 9 properties + 8 masteries ("Range" missing) | 182 (38 weapons, 13 armor; no mounts or vehicles) | 319 | 116 |
| Classes / subclasses | 12 / 12 | 12 / 12 | 12 / 12 | 12 / 12 |
| Class features | 241, plus Metamagic and Invocation option lists | 232 | 253 | inline in class files |
| Level tables | 1,812 rows: proficiency bonus, 55 spell-slot columns, 30 class columns (Druid Wild Shape and Monk Unarmored Movement missing) | 287 level rows | sparse scale values only; spell slots are computed by Foundry, not stored | Markdown tables |
| Species | 9 + 51 traits | 9 + 24 subspecies + 67 traits | 9 + 50 trait items | 9 |
| Backgrounds / feats / conditions | 4 + 20 benefits / 17 + 35 benefits / 15 | 4 / 17 / 15 | 4 / 17 / in the glossary pages | 4 / 17 / 15 |
| Rules prose | 56 rules in 11 rulesets: only Playing the Game and Character Creation | none | 43 journals, 858 HTML pages, 1,906 template tags; 42 roll tables | all chapters |

**Example records** (Open5e files, verbatim except where trimmed with `…`)
```
Spell.json {"model": "api_v2.spell", "pk": "srd-2024_fireball", "fields": {"name": "Fireball", "desc": "A bright streak flashes from you … start burning.", "level": 3, "school": "evocation", "higher_level": "The damage increases by 1d6 for each spell slot level above 3.", "range_text": "150 feet", "casting_time": "action", "material_specified": "a ball of bat guano and sulfur", "saving_throw_ability": "dexterity", "damage_roll": "8d6", "damage_types": ["fire"], "duration": "instantaneous", "shape_type": "sphere", "shape_size": 20, "concentration": false, "classes": ["srd-2024_sorcerer", "srd-2024_wizard"], …}}
SpellCastingOption.json {"pk": 10621, "fields": {"parent": "srd-2024_fireball", "type": "slot_level_4", "damage_roll": "9d6", …}}
Creature.json {"fields": {"alignment": "chaotic neutral", "armor_class": 15, "armor_detail": "natural armor", "challenge_rating": "0.250", "hit_dice": "3d6", "hit_points": 10, "initiative_bonus": 2, "languages": ["common", "goblin"], "name": "Goblin Warrior", "size": "small", "skill_bonus_stealth": 6, "type": "fey", "walk": 30, …}, "pk": "srd-2024_goblin-warrior"}
CreatureAction.json {"fields": {"action_type": "ACTION", "desc": "Melee Attack Roll: +4, reach 5 ft. 5 (1d6 + 2) Slashing damage, plus 2 (1d4) Slashing damage if the attack roll had Advantage.", "name": "Scimitar", "parent": "srd-2024_goblin-warrior", …}}
CreatureActionAttack.json {"fields": {"attack_type": "WEAPON", "damage_bonus": 2, "damage_die_count": 1, "damage_die_type": "D6", "damage_type": "slashing", "reach": 5, "to_hit_mod": 4, …}}
CharacterClass.json {"fields": {"caster_type": "FULL", "document": "srd-2024", "hit_dice": "D6", "name": "Wizard", "primary_abilities": [], "saving_throws": ["int", "wis"], "subclass_of": null}, "model": "api_v2.characterclass", "pk": "srd-2024_wizard"}
ClassFeature.json (table column) {"fields": {"desc": "[Column data]", "name": "1st", "parent": "srd-2024_wizard", "feature_type": "SPELL_SLOTS"}, "pk": "srd-2024_wizard_slots-1st"}
ClassFeatureItem.json (table cell) {"fields": {"column_value": "4", "detail": null, "level": 3, "parent": "srd-2024_wizard_slots-1st"}, "pk": "srd-2024_wizard_spell-slots-level-1_3"}
Species.json {"fields": {"desc": "", "document": "srd-2024", "name": "Dwarf", "subspecies_of": null}, "pk": "srd-2024_dwarf"}
SpeciesTrait.json {"fields": {"desc": "You have Darkvision with a range of 120 feet.", "name": "Darkvision", "order": 3, "parent": "srd-2024_dwarf", "type": null}}
Background.json {"fields": {"desc": "", "document": "srd-2024", "name": "Acolyte"}, "pk": "srd-2024_acolyte"}
BackgroundBenefit.json {"fields": {"desc": "Magic Initiate (Cleric)", "name": "Feat", "parent": "srd-2024_acolyte", "type": "feat"}}
Feat.json {"fields": {"desc": "You gain the following benefits.", "document": "srd-2024", "name": "Alert", "prerequisite": "", "type": "Origin"}, "pk": "srd-2024_alert"}
FeatBenefit.json {"fields": {"desc": "When you roll Initiative, you can add your Proficiency Bonus to the roll.", "name": "Initiative Proficiency", "parent": "srd-2024_alert", "type": null}}
MagicItem.json {"fields": {"category": "wondrous-item", "desc": "This bag has an interior space considerably larger than its outside dimensions—roughly 2 feet square … can't be reopened.", "name": "Bag of Holding", "rarity": "uncommon", "requires_attunement": false, "size": "tiny", …}, "pk": "srd-2024_bag-of-holding"}
```
Class features attach to levels the same way as table cells (`{"column_value": null, "level": 1, "parent": "srd-2024_wizard_arcane-recovery"}`). I rebuilt the full Wizard table from these rows, and levels 1–20 match the PDF.

**License and attribution text in the sources**
- **Official statement** (PDF page 1, and the top of your5e's `SRD_CC_v5.2.1.md`): "This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode." It also says not to add any other attribution to Wizards; you may say "compatible with fifth edition" or "5E compatible."
- **Open5e:** `LICENSE.md` is a modified MIT license that excludes third-party SRD content and its artwork (artwork is CC-BY-NC-4.0, so don't ship it). `Document.json` names the source "System Reference Document 5.2" with licenses `["cc-by-40"]`, and `data/v2/License.json` holds the full CC-BY-4.0 legal text. The JSON has no attribution sentence.
- **your5e:** there is no LICENSE file; the README states CC-BY-4.0 and gives the attribution.
- **Foundry:** the software is MIT. The README credits SRD 5.1 and 5.2 under CC-BY-4.0, and every record has `system.source.license: CC-BY-4.0`.
- **5e-bits:** MIT, but the README still says the underlying material is under OGL 1.0a, which is wrong for SRD 5.2.

**Caveats**
- **Open5e:**
  - The 15 magic items new in 5.2.1 are missing. Add them from your5e or Foundry.
  - Paragraph breaks are lost in 187 of 233 multi-paragraph spells and in most magic items. Use your5e's text for display and Open5e for mechanics.
  - `desc` is empty for the 12 base classes, 9 species and 4 backgrounds, and `primary_abilities` is empty.
  - Creatures:
    - `armor_detail` defaults to "natural armor" on 330 of 331.
    - XP and proficiency bonus are null on 330 of 331, so derive them from CR.
    - There is no gear field and no creature tags (such as Goblinoid).
    - "Hit:" is missing from 422 of 423 attack texts.
    - Extra-damage dice are null.
  - Some text fields contain light Markdown.
  - The repo also holds non-SRD publishers (Kobold Press, EN Publishing, Green Ronin, Open5e's own `open5e-2024`). Take only `srd-2024` plus `core`.
- **5e-bits:** the standalone `5e-database` repo is archived (deprecated 2026-10-02). The live copy is in `5e-bits/5e-srd-api` under `packages/5e-database/src/2024/en/`.
  - It is 5.2 only.
  - Monsters have no initiative or tags, and spells have no save, area or scaling data.
  - There is no rules prose.
  - There are text errors: the Wizard entry says "choose two level four spells" where the PDF says "choose four spells".
- **Foundry:**
  - Text is HTML with template tags such as `[[/attack extended]]`, `[[lookup @labels…]]` and `@UUID`/`@Embed`, which replace literal text and numbers.
  - Record IDs come from the Player's Handbook data (`phbspl…`), and the PHB-only spell Arcane Vigor is marked CC-BY-4.0.
  - 4 gear items are tagged as 2014 rules and one feature as "MM 2024".
  - Filter everything against an SRD name list before use.
- **your5e:** tables were restructured or moved, and there are a few conversion slips (for example "In sight" in the Wizard skill list).
- **Not recommended:**
  - downfallx: 5.2.1, but `<table>`/`<br>` HTML in every stat block.
  - oldmanumby: 5.2.1, but breaks lines mid-sentence and has no Summon Dragon file.
  - springbov: 5.2.
  - sycarion: mixes in SRD 5.1 races such as Half-Elf and Half-Orc.
  - Open5e `raw_sources/srd_5_2/sections`: 5.2, and its maintainers say not to use it.
  - npm `@archivist-gg/dnd5e`: freeware licence that bans redistribution.
- **Network:** `api.github.com` returns 403 from this container.

**Clones** (all shallow and blobless; the Open5e, 5e-bits, Foundry and your5e clones are sparse), under `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/`:
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/open5e-api`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/your5e-srd-markdown`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/foundry-dnd5e`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/5e-srd-api`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/5e-database`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/downfallx-srd-markdown`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/oldmanumby-srd521`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/springbov-srd52-markdown`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/sycarion-5e-2024-srd`
- `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/srd-sources/npm-archivist-dnd5e` (npm tarball, for reference only)

The PDF text I extracted for counting is in `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/derived/`: `srd521.raw.txt`, `srd52.raw.txt` and `srd521.txt`. The analysis scripts are in `/tmp/claude-0/-home-user/94f9ab68-9d79-5311-b5b8-d14c9945b1c8/scratchpad/scripts/`.
