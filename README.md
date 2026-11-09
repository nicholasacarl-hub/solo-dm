# Solo DM

**A solo tabletop RPG where Claude runs the game.** Compatible with fifth edition
(the 2024 rules, via SRD 5.2.1).

Solo DM runs entirely in your browser. Claude narrates, plays every NPC, and makes the rulings; the app keeps the books: your character sheet, dice, initiative, quests, NPCs and clocks. Claude can only change your sheet through actions you see in the log, and it never invents a die roll.

> Play it at **https://nicholasacarl-hub.github.io/solo-dm/** (after the first deploy), or run it locally (below).

## Features

- **Multiple campaigns, one save slot each**, with their own character, history and settings. Duplicate a campaign to branch it, or export it to a file.
- **2024-rules character builder**: class → background (with its ability score increases and Origin feat) → species → ability scores (standard array, point buy, or 4d6) → skills → equipment → spells.
- **A full character sheet** that Claude updates through tools (HP, conditions, exhaustion, spell slots, feature uses, inventory, coins, XP), and that you can edit too. The DM is told about your edits.
- **Your dice, your way**: auto-roll, tap to roll, or roll physical dice and type in the result. The DM rolls monsters behind the screen, and you can reveal those rolls whenever you like.
- **Combat tracker** with initiative, NPC hit points (shown as "bloodied" and so on when hidden) and conditions.
- **Battle maps** for fights where positions matter: a square grid using the 2024 grid rules. On your turn, tap a square to see the path, what it costs and what it risks (opportunity attacks, hazards, needing to Dash), then move. You can undo until you send. Measure distances, place spell templates to plan a Fireball, and play it all by keyboard or screen reader. The app does all the measuring, so the DM never guesses a distance, and creatures you haven't spotted stay off your map. Prefer theater of the mind? Switch maps off in the campaign's table rules.
- **Long-campaign memory**: a journal of NPCs, places, factions and house rules, a quest log, progress clocks for threats that advance offscreen, and session recaps. Each session starts with "previously on…".
- **Solo-play tools**: a yes/no oracle, a tension dial that can twist scenes, an X-card, and out-of-character questions (`OOC: …`).
- **Rules lookups**: the DM searches the bundled SRD 5.2.1 and anything you've imported.
- **Import your own books**: paste text, upload a PDF that has selectable text, or photograph pages (Claude transcribes them). The app finds spells, monsters, items and character options in them for you to review, and the builder, combat and spell lists use what you accept. Imports stay on your device: their text goes to Anthropic, with your own key, only when you ask Claude to read entries or transcribe photos and when the DM looks rules up, and save files and GitHub backups leave it out. JSON packs can carry text and reviewed data together ([docs/PACKS.md](docs/PACKS.md)).
- **Homebrew with guardrails**: Claude improvises spells, items, monster variants, bargains and boons whenever the story calls for them, within the homebrew freedom you set for the campaign. It balances them against named SRD comparisons and saves them to your compendium, where you can view, edit or veto them.
- **Transformations**: lasting changes to who your hero is (vampirism, lycanthropy, a fey mark, a celestial blessing), with real costs as well as powers. They come from the story, never from a quota: offered as temptations you can refuse, or, if you allow it in the campaign's table rules, brought on by choices you made knowingly. You can also switch them off. Each one shows on your sheet with its stage and how it could end.
- **Your story, your goals**: take the campaign anywhere. If you decide to found a thieves' guild or take the throne, it becomes an ambition with a progress clock. Progress comes only from what your hero actually achieves, and the world doesn't hand anyone a crown.
- **Illustrations (optional)**: Claude describes the scene, and OpenAI paints it with your own OpenAI key. Ask for one ("show me the harbor", the Show me the scene button, Paint portrait on your sheet), or let the DM illustrate key moments. Pictures stay on your device and are collected in the Gallery tab.
- **Optional cloud saves** to a private GitHub repo of yours, so the same campaigns open on any device.
- **Demo mode**: try the whole table with an offline scripted DM, no API key needed.

## What you need

An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/settings/keys). API usage is billed by Anthropic and is separate from any Claude.ai subscription. Your key is stored only in your browser. It's sent only to Anthropic's API, never to this site or anyone else.

- **Model**: Claude Opus 5.5 is the default (the best storytelling and rules judgment). Sonnet 5.5 costs half as much, and Haiku 5.5 much less.
- **Cost**: the app shows an estimated cost per session. Structuring an imported book with Claude is optional and also billed to your key; the app shows the estimate before it sends anything (see [Your books](#your-books)).
- **Caching**: prompt caching keeps long sessions affordable. Each session re-reads your campaign context at a steep discount.
- **Tip**: give the key a monthly spend limit in the Console.

**Optional, for illustrations:** an **OpenAI API key** from [platform.openai.com](https://platform.openai.com/api-keys), entered in **Settings → Illustrations**. OpenAI bills it separately, usually a few cents a picture at medium quality. Like your Anthropic key, it's stored only in your browser and sent only to OpenAI's API.

## Your books

Import a book you own and the Library can **structure** it: find its spells, monsters, magic items, gear, feats, species, backgrounds, classes and subclasses, and turn them into options the character builder, level-up, combat, the battle map, spell lists and your inventory can use. Each book gets its own page in the Library where you review what was found.

- **Free first.** The app reads what it can on your device, at no cost: clean Markdown is mostly read this way. Flattened PDF pages and unusual layouts usually need Claude.
- **Claude reads the rest, only when you ask.** Before anything is sent you see the estimate for the model in your Settings and for the cheaper ones (a price range and how long it takes), pick one, and set a spending limit (the high estimate by default, or none). The limit is checked before every request, and you can pause or cancel at any time; a paused book waits for you (only a pause caused by losing your connection picks up again by itself). As a rough guide, a long PDF costs a few dollars with Opus 5.5, about half that with Sonnet 5.5 and a few cents with Haiku 5.5 (the cheapest, so check its readings more closely). It's billed to your own Anthropic key, and the consent screen shows what you've spent on structuring so far.
- **What leaves your device.** Each entry's text, one at a time, to Anthropic's API with your key — not the book's title, your characters or your campaigns. Structuring waits while the DM is replying, so play keeps its speed. In demo mode nothing is sent; detection, offline reading, review and packs still work.
- **Moving a book.** Import the same file on your other device and your characters' copied text comes back there, even before you structure it again. Or use **Download book data** on the book's page: a file with the book's text and your review decisions, so the other device doesn't have to structure it again. It contains the whole book, so keep it for yourself. The pack format is documented in [docs/PACKS.md](docs/PACKS.md).

The app makes three promises about your books (also in **Library → About**):

1. **Your book stays on this device.** Solo DM has no server. Your book's text goes to Anthropic, with your own API key, only when you ask: when Claude structures entries (after you've seen the cost), when it transcribes photos, and when the DM looks rules up during play. If illustrations are on, the names of options you use (a species, a class) appear in picture prompts sent to OpenAI; their text never does.
2. **Nothing changes your game until you've checked it.** Structured entries wait for your review. The builder, combat, the battle map, spell lists and inventory use them only after you accept them, and you can move any of them back. *Accept confident* takes only clean readings; classes and subclasses always get a look first. (As before, the DM can search all of a book's text, and spells the importer recognized on its own keep appearing in spell lists, marked “not reviewed”.)
3. **Your campaign saves never carry your book's text.** Anything copied from a book onto your character remembers where it came from. Save files and GitHub backups keep the names and leave the text out; a device that has the book fills it back in. The only file that holds a book's text is **Download book data**, which you make yourself.

## How it works

```
You type → Claude (streaming, with tools) → tools run in the app → state updates → narration
```

- **Sessions**: a campaign is played in sessions. Within a session, the conversation with Claude is *append-only*: the system prompt is frozen, and new state arrives as a short `<game_state>` block with each of your messages. Ending a session asks the DM for a recap and private notes. Those become the "chronicle" that starts the next session.
- **Books**: the app structures an import on your device first and, when you ask, has Claude read what it couldn't (or anything you pick), one entry per request. The structured data sits beside the book's text and reaches the builder, combat and the DM only once you accept it. See [Structured imports](docs/DESIGN.md#structured-imports).
- **Tools**: the DM acts through 25 tools. It can roll dice, ask you to roll, update your sheet, transform your hero, run combat on a battle map, look up rules, write homebrew, keep the journal and quests, set the scene, ask for an illustration, and consult the oracle. See [docs/DESIGN.md](docs/DESIGN.md).

## Run it locally

```bash
npm install
npm run dev
```

```bash
npm test            # unit and component tests
npm run build       # production build in dist/
npm run build:srd   # regenerate SRD data (see scripts/fetch-srd-sources.sh)
```

## Deploying your own copy

Pushing to `main` builds, tests and publishes the site with GitHub Actions
(`.github/workflows/deploy.yml`). Enable it once: **Settings → Pages → Source: GitHub Actions**.

## Rules content and licensing

- **Code**: MIT ([LICENSE](LICENSE)).
- **Rules text**: the bundled rules come from the **System Reference Document 5.2.1** by Wizards of the Coast LLC, licensed under CC-BY-4.0. See [ATTRIBUTION.md](ATTRIBUTION.md) for the full attribution and what was modified.
- **Not official**: Solo DM is an unofficial fan project. It is not affiliated with, endorsed or approved by Wizards of the Coast.
- **Your books**: content you import from books you own stays in your browser and is never part of this repository. Characters remember which book a feature came from; save files and GitHub backups keep the names and leave the text out.
