import '../testing/setup';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RollLogEntry } from '@/types';
import { RollCard } from './RollCard';

/** A visible DM roll: d20 (12) + 2 = 14 against 10, which it beats. */
const entry = (patch: Partial<RollLogEntry> = {}): RollLogEntry => ({
  id: 'log-roll',
  campaignId: 'camp-1',
  sessionId: 'sess-1',
  seq: 30,
  createdAt: 1,
  kind: 'roll',
  actor: 'dm',
  secret: false,
  purpose: "Attack Dog's Constitution save to keep concentration",
  roll: { expression: '1d20+2', total: 14, dice: [{ sides: 20, value: 12 }], modifier: 2, breakdown: 'd20 (12) + 2 = 14', natural: 12, dc: 10, success: true },
  ...patch,
});

/** The same roll with a d20 of 6: 8, short of 10. */
const short: RollLogEntry['roll'] = { ...entry().roll, total: 8, dice: [{ sides: 20, value: 6 }], breakdown: 'd20 (6) + 2 = 8', natural: 6, success: false };

/** The card as the player reads it, its badges included. */
function cardText(e: RollLogEntry): string {
  const { container, unmount } = render(<RollCard entry={e} />);
  const text = container.textContent ?? '';
  unmount();
  return text;
}

// srd:rule:concentration: "If you take damage, you must succeed on a Constitution saving throw to maintain
// Concentration. The DC equals 10 or half the damage taken". D8: a creature named like "Attack Dog" never gets an attack
// card (RX3).
describe('RollCard: saves read as saves', () => {
  it("shows the app's Concentration save card (rollType 'save') against a DC, with Success or Failure", () => {
    render(<RollCard entry={entry({ rollType: 'save' })} />);
    expect(screen.getByText('vs DC 10')).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.queryByText(/^vs AC/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Hit|Miss)$/)).not.toBeInTheDocument();
    expect(cardText(entry({ rollType: 'save', roll: short }))).toMatch(/vs DC 10Failure$/);
  });

  it('shows the same save rolled by the DM with roll_dice (logged without its kind) the same way, never Hit or vs AC', () => {
    expect(cardText(entry())).toMatch(/vs DC 10Success$/);
    expect(cardText(entry({ roll: short }))).toMatch(/vs DC 10Failure$/);
    for (const e of [entry(), entry({ roll: short })]) expect(cardText(e)).not.toMatch(/vs AC|Hit|Miss/);
  });

  it('still shows an attack against AC with Hit or Miss, and a check by its kind', () => {
    const goblin = entry({ purpose: 'Goblin attack', roll: { ...entry().roll, dc: 13 } });
    render(<RollCard entry={goblin} />);
    expect(screen.getByText('vs AC 13')).toBeInTheDocument();
    expect(screen.getByText('Hit')).toBeInTheDocument();
    expect(cardText({ ...goblin, roll: { ...short, dc: 13 } })).toMatch(/vs AC 13Miss$/);
    // A check is against a DC whatever its purpose names: its kind decides.
    const shove = entry({ actor: 'player', rollType: 'skill', purpose: "Athletics check to break the Attack Dog's grapple", roll: { ...entry().roll, dc: 13 } });
    expect(cardText(shove)).toMatch(/vs DC 13Success$/);
  });
});
