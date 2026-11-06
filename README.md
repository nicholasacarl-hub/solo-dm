# Solo DM

**A solo tabletop RPG where Claude is your Dungeon Master.** Compatible with fifth edition
(the 2024 rules, via SRD 5.2.1).

Solo DM runs entirely in your browser. Claude narrates, plays every NPC, and makes the rulings; the app keeps the books: your character sheet, dice, initiative, quests, NPCs and clocks. Claude can only change your sheet through actions you see in the log, and it never invents a die roll.

> Play it at **https://nicholasacarl-hub.github.io/solo-dm/** (after the first deploy), or run it locally (below).

## Features

- **Multiple campaigns, one save slot each**, with their own character, history and settings. Duplicate a campaign to branch it, or export it to a file.
- **2024-rules character builder**: class → background (with its ability score increases and Origin feat) → species → ability scores (standard array, point buy, or 4d6) → skills → equipment → spells.
- **A full character sheet** that Claude updates through tools (HP, conditions, exhaustion, spell slots, feature uses, inventory, coins, XP), and that you can edit too. The DM is told about your edits.
- **Your dice, your way**: auto-roll, tap to roll, or roll physical dice and type in the result. The DM rolls monsters behind the screen, and you can reveal those rolls whenever you like.
- **Combat tracker** with initiative, NPC hit points (shown as "bloodied" and so on when hidden) and conditions.
- **Long-campaign memory**: a journal of NPCs, places, factions and house rules, a quest log, progress clocks for threats that advance offscreen, and session recaps. Each session starts with "previously on…".
- **Solo-play tools**: a yes/no oracle, a tension dial that can twist scenes, an X-card, and out-of-character questions (`OOC: …`).
- **Rules lookups**: the DM searches the bundled SRD 5.2.1 and anything you've imported.
- **Import your own books**: paste text, upload a PDF that has selectable text, or photograph pages (Claude transcribes them). Imports stay on your device.
- **Homebrew with guardrails**: Claude can invent or modify spells, items, monsters and boons, within the homebrew freedom you set for the campaign. It balances them against named SRD comparisons and saves them to your compendium, where you can view, edit or veto them.
- **Optional cloud saves** to a private GitHub repo of yours, so the same campaigns open on any device.
- **Demo mode**: try the whole table with an offline scripted DM, no API key needed.

## What you need

An **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/settings/keys). API usage is billed by Anthropic and is separate from any Claude.ai subscription. Your key is stored only in your browser. It's sent only to Anthropic's API, never to this site or anyone else.

- **Model**: Claude Opus 5.5 is the default (the best storytelling and rules judgment). Sonnet 5.5 costs half as much, and Haiku 5.5 much less.
- **Cost**: the app shows an estimated cost per session.
- **Caching**: prompt caching keeps long sessions affordable. Each session re-reads your campaign context at a steep discount.
- **Tip**: give the key a monthly spend limit in the Console.

## How it works

```
You type → Claude (streaming, with tools) → tools run in the app → state updates → narration
```

- **Sessions**: a campaign is played in sessions. Within a session, the conversation with Claude is *append-only*: the system prompt is frozen, and new state arrives as a short `<game_state>` block with each of your messages. Ending a session asks the DM for a recap and private notes. Those become the "chronicle" that starts the next session.
- **Tools**: the DM acts through about 20 tools. It can roll dice, ask you to roll, update your sheet, run combat, look up rules, write homebrew, keep the journal and quests, set the scene, and consult the oracle. See [docs/DESIGN.md](docs/DESIGN.md).

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
- **Your books**: content you import from books you own stays in your browser and is never part of this repository.
