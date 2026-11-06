# Solo DM — notes for Claude

Solo DM is a static React app (GitHub Pages) where Claude is the Dungeon Master for a solo player
using the 2024 fifth-edition rules (SRD 5.2.1). Read `docs/DESIGN.md` before making changes.

## Commands

```bash
npm run dev        # Vite dev server
npm test           # Vitest (unit + component tests)
npm run typecheck  # tsc for app and config
npm run build      # typecheck + production build
npm run build:srd  # regenerate public/srd/ from the upstream SRD sources (see scripts/)
```

## Map

- `src/types/` — the shared contract. Change types deliberately and update every caller.
- `src/engine/` — pure rules logic (dice, stats, HP, slots, rests, leveling, combat, oracle). No I/O, no React.
- `src/data/` — SRD loaders, rules search (MiniSearch), character-builder data, import pipeline.
- `src/storage/` — IndexedDB (Dexie), save slots, backups, GitHub cloud saves.
- `src/state/` — Zustand stores. `gameStore` is write-through to storage.
- `src/dm/` — the Claude DM: prompts, tools, the streaming agent loop, sessions, the offline mock DM.
- `src/ui/` — screens and components. Shared primitives live in `src/ui/components/ui.tsx`.

## Rules that must not be broken

1. **The DM transcript is append-only within a session.** The system prompt is frozen on the
   Session, the tools array is static, and earlier transcript messages are never edited — only
   trimmed from the end (regenerate/cancel). New information goes in the next user message's
   `<game_state>` block or an appended `role: "system"` message. Breaking this kills prompt caching
   and, with preserved thinking on Claude Opus 5.5, invalidates thinking blocks (400s for newer
   accounts).
2. **The app owns game state; Claude never invents numbers.** All randomness comes from
   `src/engine/dice.ts` (crypto RNG). State changes go through tools → engine → store.
3. **No copyrighted non-SRD content in the repo.** Only SRD 5.2.1 (CC-BY-4.0, attribution in
   `ATTRIBUTION.md`). Player imports live only in the player's browser. Describe the app as
   "compatible with fifth edition"; don't use Wizards of the Coast trademarks in branding.
4. **Claude API usage:** default model `claude-opus-5-5`; adaptive thinking only (no budgets, no
   `disabled`); effort via `output_config.effort`; no `temperature`/`top_p`/`top_k`; no forced
   `tool_choice`; handle `stop_reason: "refusal"`; keep the request builder in one place
   (`src/dm/`) so it is easy to audit.
5. **Keep the engine pure and tested.** New rules logic gets unit tests that cite the SRD section.

## Conventions

- TypeScript strict; import via `@/…`; no `dangerouslySetInnerHTML` (render markdown with
  `src/ui/components/Markdown.tsx`).
- UI uses theme tokens from `src/index.css`; mobile-first; accessible labels and keyboard support.
- Tests next to the code (`*.test.ts(x)`); use fixtures from `src/test/fixtures.ts`.
