/**
 * The map's key (legend) and its help: the input model, every key, and the grid conventions the app uses where the
 * SRD is silent (app conventions C8, C19, C21), each in one line.
 */
import { useId, type ReactNode } from 'react';
import { Dialog } from '@/ui/components/ui';

/** One line each for the app's own grid conventions (never worded as SRD text). */
export const MAP_CONVENTIONS: readonly string[] = [
  "Diagonals: you can't cut the corner of a wall, a closed door or three-quarters cover.",
  'Areas: a square counts when its centre is inside. Spheres are round; cones, lines and emanations are measured like movement.',
  "Cover: from the attacker's best corner to the target's least-covered square — 1–2 of 4 lines blocked is Half, 3–4 Three-Quarters, all of them by walls Total.",
];

function Swatch({ children, label }: { children: (id: string) => ReactNode; label: string }) {
  const id = `key${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <li className="flex items-center gap-2 text-xs text-muted">
      <svg viewBox="0 0 24 24" className="size-6 shrink-0 overflow-visible rounded-sm" aria-hidden>
        {children(id)}
      </svg>
      <span>{label}</span>
    </li>
  );
}

const floor = <rect width="24" height="24" fill="var(--map-floor)" stroke="var(--border)" strokeWidth="1" />;

export function MapKey() {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <section aria-label="Terrain">
        <h3 className="mb-1.5 font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Terrain</h3>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Swatch label="Wall">{() => <rect width="24" height="24" fill="var(--map-wall)" />}</Swatch>
          <Swatch label="Door (closed · open)">
            {() => (
              <>
                {floor}
                <rect x="2" y="8" width="9" height="8" rx="1.5" fill="var(--map-door)" />
                <rect x="13" y="8" width="9" height="8" rx="1.5" fill="var(--map-floor)" stroke="var(--map-door)" strokeWidth="1.5" strokeDasharray="2 1.5" />
              </>
            )}
          </Swatch>
          <Swatch label="Difficult terrain">
            {(id) => (
              <>
                <defs>
                  <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="5" stroke="var(--map-difficult)" strokeWidth="1.4" />
                  </pattern>
                </defs>
                {floor}
                <rect width="24" height="24" fill={`url(#${id})`} />
              </>
            )}
          </Swatch>
          <Swatch label="Water (shallow · deep)">
            {() => (
              <>
                <rect width="12" height="24" fill="var(--map-water)" opacity="0.6" />
                <rect x="12" width="12" height="24" fill="var(--map-water)" />
                <path d="M1 12q2.5-2 5 0t5 0M13 8q2.5-2 5 0t5 0M13 16q2.5-2 5 0t5 0" fill="none" stroke="var(--map-water-ink)" strokeWidth="1.3" />
              </>
            )}
          </Swatch>
          <Swatch label="Pit">{() => <rect x="1" y="1" width="22" height="22" fill="var(--map-pit)" stroke="var(--map-wall)" strokeWidth="2" />}</Swatch>
          <Swatch label="Hazard">
            {(id) => (
              <>
                <defs>
                  <pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
                    <line x1="0" y1="0" x2="0" y2="7" stroke="var(--map-hazard)" strokeWidth="2.4" />
                  </pattern>
                </defs>
                {floor}
                <rect width="24" height="24" fill={`url(#${id})`} />
              </>
            )}
          </Swatch>
          <Swatch label="Half cover · ¾ cover">
            {() => (
              <>
                <rect width="12" height="24" fill="var(--map-cover)" opacity="0.4" />
                <rect x="12" width="12" height="24" fill="var(--map-cover)" opacity="0.7" />
                <text x="6" y="16" fontSize="10" textAnchor="middle" fontWeight="700" fill="var(--text)">
                  ½
                </text>
                <text x="18" y="16" fontSize="10" textAnchor="middle" fontWeight="700" fill="var(--map-floor)">
                  ¾
                </text>
              </>
            )}
          </Swatch>
          <Swatch label="Heavily obscured">
            {() => (
              <>
                {floor}
                {[4, 12, 20].map((x) => [4, 12, 20].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="var(--map-obscured)" />))}
              </>
            )}
          </Swatch>
        </ul>
      </section>
      <section aria-label="Creatures">
        <h3 className="mb-1.5 font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Creatures</h3>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Swatch label="You (★)">
            {() => (
              <>
                <circle cx="12" cy="12" r="10" fill="var(--accent)" />
                <circle cx="12" cy="12" r="7.5" fill="none" stroke="var(--text)" strokeWidth="1" />
              </>
            )}
          </Swatch>
          <Swatch label="Ally (blue circle)">{() => <circle cx="12" cy="12" r="10" fill="var(--info)" />}</Swatch>
          <Swatch label="Enemy (red diamond)">{() => <path d="M12 1L23 12L12 23L1 12Z" fill="var(--danger)" />}</Swatch>
          <Swatch label="Neutral (dashed ring)">
            {() => <circle cx="12" cy="12" r="9.5" fill="var(--surface-3)" stroke="var(--faint)" strokeWidth="1.6" strokeDasharray="3 2" />}
          </Swatch>
          <Swatch label="Whose turn (ring and ▾)">
            {() => (
              <>
                <circle cx="12" cy="13" r="7" fill="var(--danger)" />
                <circle cx="12" cy="13" r="10" fill="none" stroke="var(--text)" strokeWidth="2" />
              </>
            )}
          </Swatch>
          <Swatch label="Bloodied · critical · down">
            {() => (
              <>
                <path d="M6 4C9 8 10 10 10 12A4 4 0 0 1 2 12C2 10 3 8 6 4Z" fill="none" stroke="var(--danger)" strokeWidth="1.2" />
                <path d="M2 12A4 4 0 0 0 10 12Z" fill="var(--danger)" />
                <path d="M17 18C13 15 12 12 14 10.5C15.5 9.5 16.6 10 17 11C17.4 10 18.5 9.5 20 10.5C22 12 21 15 17 18Z" fill="var(--danger)" />
              </>
            )}
          </Swatch>
        </ul>
      </section>
      <section aria-label="Movement">
        <h3 className="mb-1.5 font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">Your movement</h3>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <Swatch label="This turn (solid edge)">
            {() => <rect x="1" y="1" width="22" height="22" fill="var(--accent)" fillOpacity="0.16" stroke="var(--accent)" strokeWidth="1.5" />}
          </Swatch>
          <Swatch label="With Dash (dashed edge)">
            {() => <rect x="1" y="1" width="22" height="22" fill="var(--accent)" fillOpacity="0.08" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="3 2" />}
          </Swatch>
          <Swatch label="Enemy reach (dashed red)">
            {() => <rect x="1" y="1" width="22" height="22" fill="none" stroke="var(--danger)" strokeWidth="1.5" strokeDasharray="2.5 2.5" />}
          </Swatch>
          <Swatch label="Opportunity Attack (!)">
            {() => (
              <>
                <circle cx="12" cy="12" r="9" fill="var(--danger)" />
                <text x="12" y="16" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--token-ink)">
                  !
                </text>
              </>
            )}
          </Swatch>
        </ul>
      </section>
      <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
        {MAP_CONVENTIONS.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

const KEYS: readonly [string, string][] = [
  ['← → ↑ ↓ (Shift: 5 squares) · Home / End · Page Up / Page Down', 'Move the cursor; the map follows it'],
  ['Enter or Space', 'Move: plan to the cursor, then move. Measure: measure to it. Area: place or aim. On a creature: its card'],
  ['Esc', 'Cancel the plan, close a card, leave Measure or Area'],
  ['N / Shift+N · H · T', 'Next / previous creature · you · whose turn it is'],
  ['V · M · A', 'Move · Measure · Area'],
  ['R / Shift+R', 'Turn a cone or line 45°'],
  ['D · G', 'Dash · Disengage (while planning)'],
  ['U', 'Undo your last move (until you send)'],
  ['+ − 0 · C · L · ?', 'Zoom · fit the map · centre on you · list view · this help'],
];

export function MapHelpDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} title="The battle map" size="md">
      <div className="flex flex-col gap-4 text-sm">
        <section>
          <h3 className="mb-1 font-semibold">Moving</h3>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-muted">
            <li>On a touch screen, tap a square to plan your move and tap it again (or Move) to go there.</li>
            <li>With a mouse, hover to see the route and click to move. If the move would provoke an Opportunity Attack, cross a hazard or need a Dash, the first click only plans it.</li>
            <li>The route avoids Opportunity Attacks when it can. If you leave an enemy's reach anyway, you stop there until the DM resolves the attack — then tell the DM where you were going.</li>
            <li>Your moves reach the DM with your next message. Undo works until you send.</li>
            <li>Drag to pan, pinch or Ctrl + scroll to zoom, or use the zoom buttons. Long-press or right-click a square or creature for its details.</li>
          </ul>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">Keys (while the map has focus)</h3>
          <table className="w-full text-left text-xs">
            <tbody className="divide-y divide-border">
              {KEYS.map(([keys, what]) => (
                <tr key={keys}>
                  <th scope="row" className="py-1.5 pr-3 align-top font-semibold whitespace-nowrap">
                    {keys}
                  </th>
                  <td className="py-1.5 text-muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h3 className="mb-1 font-semibold">How the map counts</h3>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-muted">
            <li>Every square is 5 feet, diagonals included; Difficult Terrain costs 5 feet more per square.</li>
            {MAP_CONVENTIONS.map((c) => (
              <li key={c}>{c}</li>
            ))}
            <li>Cover and line of sight are what the map shows; the DM can still rule otherwise.</li>
          </ul>
        </section>
      </div>
    </Dialog>
  );
}
