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

- **Structured imports**: have Claude convert pasted stat blocks, spells and items from the player's
  books into structured entries (with a review step), so imported monsters and spells work with the
  combat tracker and spell list as well as SRD ones.
- **Spell effects**: concentration tracking on combatants, durations that tick down by round, and
  spell-based AC (Mage Armor, Shield of Faith).
- **Class extras**: Unarmored Movement, lineage spells gained at levels 3 and 5, and replacing
  "Action Surge (two uses)" / "Indomitable" entries in place at Fighter 13 and 17.
- **Level-up choices**: guided ASI/feat, subclass and spell selection in the level-up dialog, using the
  class tables already in `public/srd/builder.json`.

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
