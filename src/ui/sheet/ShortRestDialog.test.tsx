import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sampleCampaign, sampleCharacter } from '@/test/fixtures';
import type { InteractionRequest } from '@/types';
import { clearRolls, queueRolls } from '@/ui/builder/testing/fakeEngine';
import { installDialogPolyfill, resetFakeGame } from '@/ui/builder/testing/fakeGameStore';
import { ShortRestDialog } from './ShortRestDialog';

vi.mock('@/engine', async () => (await import('@/ui/builder/testing/fakeEngine')).fakeEngine);
vi.mock('@/state/gameStore', async () => (await import('@/ui/builder/testing/fakeGameStore')).fakeGameStoreModule());

type ShortRest = Extract<InteractionRequest, { kind: 'short-rest' }>;

const request = (overrides: Partial<ShortRest> = {}): ShortRest => ({
  kind: 'short-rest',
  id: 'rest-1',
  hitDice: [{ die: 6, total: 3, spent: 1 }],
  conMod: 1,
  ...overrides,
});

function withRollMode(mode: 'prompt' | 'physical') {
  const campaign = sampleCampaign();
  resetFakeGame({ campaign: { ...campaign, settings: { ...campaign.settings, playerRollMode: mode } }, character: sampleCharacter() });
}

beforeAll(() => installDialogPolyfill());
afterEach(cleanup);

beforeEach(() => {
  clearRolls();
  withRollMode('prompt');
});

describe('ShortRestDialog', () => {
  it('rolls each hit die with the CON modifier and reports what was spent', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    queueRolls(4, 2);
    render(<ShortRestDialog request={request()} onDone={onDone} onCancel={vi.fn()} />);
    expect(screen.getByText(/2 left/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Spend a d6' }));
    await user.click(screen.getByRole('button', { name: 'Spend a d6' }));
    expect(screen.getByText('None left')).toBeInTheDocument();
    expect(screen.getByText('Rolled healing:').textContent).toContain('8');

    // Mira has 12/17 HP: only 5 of the 8 rolled can be regained.
    await user.click(screen.getByRole('button', { name: 'Done — +5 HP' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    const { spent } = onDone.mock.calls[0][0];
    expect(spent.map((s: { die: number; healed: number; roll: { expression: string; total: number } }) => [s.die, s.roll.expression, s.roll.total, s.healed])).toEqual([
      [6, '1d6+1', 5, 5],
      [6, '1d6+1', 3, 3],
    ]);
  });

  it('heals at least 1 HP per die', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    queueRolls(1);
    render(<ShortRestDialog request={request({ conMod: -2 })} onDone={onDone} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Spend a d6' }));
    await user.click(screen.getByRole('button', { name: 'Done — +1 HP' }));
    expect(onDone.mock.calls[0][0].spent[0]).toMatchObject({ healed: 1, roll: { total: -1 } });
  });

  it('takes typed results in physical-dice mode', async () => {
    const user = userEvent.setup();
    withRollMode('physical');
    const onDone = vi.fn();
    render(<ShortRestDialog request={request()} onDone={onDone} onCancel={vi.fn()} />);
    const input = screen.getByLabelText('Your d6 result');
    await user.type(input, '7');
    await user.click(screen.getByRole('button', { name: 'Spend' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A d6 shows a number from 1 to 6.');
    await user.clear(input);
    await user.type(input, '3');
    await user.click(screen.getByRole('button', { name: 'Spend' }));
    await user.click(screen.getByRole('button', { name: 'Done — +4 HP' }));
    expect(onDone.mock.calls[0][0].spent).toEqual([{ die: 6, healed: 4, roll: expect.objectContaining({ expression: '1d6+1', total: 4 }) }]);
  });

  it('can finish without spending dice, or cancel', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(<ShortRestDialog request={request()} onDone={onDone} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel rest' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith({ spent: [] });
  });
});
