import './testing/setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualD20Result, manualRollResult, rollD20Test, rollDice } from '@/engine';
import { useSettings } from '@/state/settingsStore';
import type { InteractionRequest, PlayerRollRequest } from '@/types';
import { RESULT_HOLD_MS, RollPromptDialog, ROLL_ANIMATION_MS } from './RollPromptDialog';
import { queueD20, resetEngineMock } from './testing/engineMock';
import { seedGame } from './testing/seed';

vi.mock('@/engine', () => import('./testing/engineMock'));

type RollInteraction = Extract<InteractionRequest, { kind: 'roll' }>;

function interaction(
  request: Partial<PlayerRollRequest> = {},
  modifier = 2,
  label = 'Stealth check (DEX)',
): RollInteraction {
  return {
    kind: 'roll',
    id: 'roll-1',
    modifier,
    label,
    request: {
      rollType: 'skill',
      skill: 'stealth',
      dc: 13,
      revealDc: true,
      advantage: 'normal',
      reason: 'Slip past the guards',
      ...request,
    },
  };
}

function renderPrompt(i: RollInteraction, mode: 'prompt' | 'physical' | 'auto' = 'physical') {
  const onResolve = vi.fn();
  const onCancelTurn = vi.fn();
  seedGame();
  render(<RollPromptDialog interaction={i} mode={mode} onResolve={onResolve} onCancelTurn={onCancelTurn} />);
  return { onResolve, onCancelTurn, user: userEvent.setup() };
}

beforeEach(() => {
  resetEngineMock();
  useSettings.setState({ diceAnimations: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RollPromptDialog — physical dice', () => {
  it('shows the reason, label, modifier breakdown and DC', () => {
    renderPrompt(interaction());
    expect(screen.getByRole('heading', { name: 'Stealth check (DEX)' })).toBeInTheDocument();
    expect(screen.getByText('Slip past the guards')).toBeInTheDocument();
    expect(screen.getByText('d20 + 2')).toBeInTheDocument();
    expect(screen.getByText('DEX +2')).toBeInTheDocument();
    expect(screen.getByText('DC 13')).toBeInTheDocument();
    expect(screen.getByText('Roll a d20 and enter the number it shows.')).toBeInTheDocument();
  });

  it('computes success against the DC from the natural d20', async () => {
    const { onResolve, user } = renderPrompt(interaction());
    await user.type(screen.getByLabelText('Your d20'), '11');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));

    expect(manualD20Result).toHaveBeenCalledWith(11, 2, { advantage: 'normal', dc: 13 });
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText(/11 \+ 2 = 13/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 11, total: 13, dc: 13, success: true }),
      manual: true,
    });
  });

  it('reports failure when the total misses the DC', async () => {
    const { onResolve, user } = renderPrompt(interaction());
    await user.type(screen.getByLabelText('Your d20'), '10');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    expect(screen.getByText('Failure')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ total: 12, success: false }),
      manual: true,
    });
  });

  it('lets the player fix a typo before continuing', async () => {
    const { onResolve, user } = renderPrompt(interaction());
    await user.type(screen.getByLabelText('Your d20'), '3');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.type(screen.getByLabelText('Your d20'), '13');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 13, total: 15 }),
      manual: true,
    });
  });

  it('explains advantage and disadvantage for physical dice', () => {
    renderPrompt(interaction({ advantage: 'advantage' }));
    expect(screen.getByText('Advantage: roll two d20s and enter the higher.')).toBeInTheDocument();
    expect(screen.getByText('Advantage')).toBeInTheDocument();
  });

  it('rejects numbers a d20 cannot show', async () => {
    const { onResolve, user } = renderPrompt(interaction({ advantage: 'disadvantage' }));
    expect(screen.getByText('Disadvantage: roll two d20s and enter the lower.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your d20'), '21');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    expect(screen.getByRole('alert')).toHaveTextContent('A d20 shows a number from 1 to 20.');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('keeps a hidden DC hidden: no DC badge and no success label', async () => {
    const { user } = renderPrompt(interaction({ revealDc: false }));
    expect(screen.queryByText('DC 13')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Your d20'), '15');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    expect(screen.queryByText('Success')).not.toBeInTheDocument();
    expect(screen.getByText('The DM will tell you how it goes.')).toBeInTheDocument();
  });

  it('asks for the total of damage dice, doubled on a critical hit', async () => {
    const { onResolve, user } = renderPrompt(
      interaction(
        { rollType: 'damage', expression: '1d8+3', critical: true, dc: undefined, revealDc: false },
        0,
        'Longsword damage',
      ),
    );
    expect(
      screen.getByText('Critical hit: roll 2d8+3 (the dice are doubled) and enter the total, including the +3.'),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Your total'), '14');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    expect(manualRollResult).toHaveBeenCalledWith('2d8+3', 14);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({ result: expect.objectContaining({ total: 14 }), manual: true });
  });

  it('offers to cancel the DM turn before rolling', async () => {
    const { onCancelTurn, user } = renderPrompt(interaction());
    await user.click(screen.getByRole('button', { name: 'Cancel turn' }));
    expect(onCancelTurn).toHaveBeenCalledTimes(1);
  });
});

describe('RollPromptDialog — tap to roll', () => {
  it('rolls with the engine, shows the result and resolves on Continue', async () => {
    queueD20(17);
    const { onResolve, user } = renderPrompt(interaction(), 'prompt');
    await user.click(screen.getByRole('button', { name: 'Roll' }));

    expect(rollD20Test).toHaveBeenCalledWith(2, { advantage: 'normal', dc: 13 });
    expect(screen.getByText(/17 \+ 2 = 19/)).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 17, total: 19, success: true }),
      manual: false,
    });
  });

  // Fake-timer tests use fireEvent: RTL's async wrapper waits on a real setTimeout(0).
  it('continues on its own after a moment', () => {
    vi.useFakeTimers();
    queueD20(5);
    const { onResolve } = renderPrompt(interaction(), 'prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    expect(onResolve).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(RESULT_HOLD_MS + 10);
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 5, success: false }),
      manual: false,
    });
  });

  it('tumbles the die first when dice animations are on', () => {
    vi.useFakeTimers();
    useSettings.setState({ diceAnimations: true });
    queueD20(12);
    renderPrompt(interaction(), 'prompt');
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    expect(screen.getByRole('button', { name: /Rolling/ })).toBeDisabled();
    expect(screen.queryByText(/12 \+ 2 = 14/)).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(ROLL_ANIMATION_MS + 10);
    });
    expect(screen.getByText(/12 \+ 2 = 14/)).toBeInTheDocument();
  });

  it('shows both d20s with advantage, the dropped one struck through', async () => {
    queueD20(4, 16);
    const { user } = renderPrompt(interaction({ advantage: 'advantage' }), 'prompt');
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    expect(screen.getByText('4', { selector: 's' })).toBeInTheDocument();
    expect(screen.getByText(/= 18/)).toBeInTheDocument();
  });

  it('rolls damage dice with the critical flag', async () => {
    const { onResolve, user } = renderPrompt(
      interaction(
        { rollType: 'damage', expression: '1d6+2', critical: true, dc: undefined, revealDc: false },
        0,
        'Dagger damage',
      ),
      'prompt',
    );
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    expect(rollDice).toHaveBeenCalledWith('1d6+2', { critical: true });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({ result: expect.objectContaining({ total: 8 }), manual: false });
  });

  it('counts a natural 20 attack as a hit even below the AC', async () => {
    queueD20(20);
    const { onResolve, user } = renderPrompt(
      interaction({ rollType: 'attack', attackName: 'Dagger', skill: undefined, dc: 25 }, 4, 'Dagger attack'),
      'prompt',
    );
    expect(screen.getByText('AC 25')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    expect(screen.getByText('Critical hit')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 20, total: 24, success: true }),
      manual: false,
    });
  });

  it('treats the "auto" mode as tap-to-roll if a prompt reaches the UI anyway', () => {
    renderPrompt(interaction(), 'auto');
    expect(screen.getByRole('button', { name: 'Roll' })).toBeInTheDocument();
  });
});
