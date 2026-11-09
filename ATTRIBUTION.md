# Attribution

## System Reference Document 5.2.1

This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.

**Modifications.** The SRD text in `public/srd/` was converted from Markdown to JSON, split into one entry per rules section, spell, creature, item, class, species, background and feat, and given one-line summaries. Structured fields (spell levels, creature statistics, class level tables and similar) were derived from the same SRD 5.2.1 content as published in machine-readable form by:

- [your5e/5e-srd-markdown](https://github.com/your5e/5e-srd-markdown) — SRD 5.2.1 converted to Markdown (CC-BY-4.0).
- [open5e/open5e-api](https://github.com/open5e/open5e-api) — the `srd-2024` dataset (SRD content, CC-BY-4.0). Open5e artwork is not used.

`scripts/fetch-srd-sources.sh` and `scripts/build-srd.mjs` reproduce the conversion.

Solo DM is an unofficial fan project, **compatible with fifth edition**. It is not affiliated with, endorsed, sponsored, or approved by Wizards of the Coast.

## Your own content

Books and notes you import into Solo DM stay in your browser's storage on your device. They are never added to this repository, and Solo DM has no server. Their text goes to Anthropic's API, with your own API key, only when you ask: when Claude structures a book's entries (one entry per request, after you've seen the cost), when it transcribes photographed pages, and when the DM looks rules up during play. The structured data the app reads from a book, and your review of it, stay on your device too.

When the DM looks something up in an imported book, that passage is removed from exported save files and GitHub cloud saves. Character features copied from imported books are also left out of exports and GitHub saves (their names stay); a device that has the book fills them back in. What the DM writes in its own words — narration, journal entries, homebrew — may still paraphrase or quote what it read. The only file that holds a book's text is "Download book data", which you make yourself; keep it for yourself.

Only import content you own.

## Fonts and icons

- [Inter](https://rsms.me/inter/), [Spectral](https://github.com/productiontype/Spectral) and [Cinzel](https://github.com/NDISCOVER/Cinzel) — SIL Open Font License 1.1, bundled via [Fontsource](https://fontsource.org).
- [Lucide](https://lucide.dev) icons — ISC License.
