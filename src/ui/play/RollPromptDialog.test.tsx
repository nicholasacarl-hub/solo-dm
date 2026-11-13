import './testing/setup';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manualD20Result, manualRollResult, rollD20Test, rollDice } from '@/engine';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { sampleCharacter } from '@/test/fixtures';
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

function renderPrompt(
  i: RollInteraction,
  mode: 'prompt' | 'physical' | 'auto' = 'physical',
  { inspiration = false }: { inspiration?: boolean } = {},
) {
  const onResolve = vi.fn();
  const onCancelTurn = vi.fn();
  const spies = seedGame({ character: { ...sampleCharacter(), heroicInspiration: inspiration } });
  render(<RollPromptDialog interaction={i} mode={mode} onResolve={onResolve} onCancelTurn={onCancelTurn} />);
  return { onResolve, onCancelTurn, spies, user: userEvent.setup() };
}

const REROLL = 'Reroll with Heroic Inspiration';

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

  it("asks a Halfling to reroll only the d20 that showed 1 for Luck (SRD 5.2.1 Halfling)", async () => {
    const { onResolve, user } = renderPrompt({ ...interaction({ advantage: 'disadvantage' }), luck: true });
    expect(screen.getByText('Luck: roll the d20 that showed 1 again, then enter the lower of your two d20s.')).toBeInTheDocument();
    expect(screen.queryByText('Disadvantage: roll two d20s and enter the lower.')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Your d20'), '9');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve.mock.calls[0][0].result).toMatchObject({ natural: 9 });
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

describe('RollPromptDialog — Heroic Inspiration', () => {
  it('is offered only to a hero who has it', async () => {
    queueD20(5);
    const { user } = renderPrompt(interaction(), 'prompt');
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    expect(screen.queryByRole('button', { name: REROLL })).not.toBeInTheDocument();
  });

  it('waits for the choice instead of continuing on its own', () => {
    vi.useFakeTimers();
    queueD20(5);
    const { onResolve } = renderPrompt(interaction(), 'prompt', { inspiration: true });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    act(() => {
      vi.advanceTimersByTime(RESULT_HOLD_MS * 3);
    });
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: REROLL })).toBeInTheDocument();
  });

  it('rerolls once with the engine, must use the new roll, and spends Inspiration before the DM gets it', async () => {
    queueD20(5, 18);
    const { onResolve, spies, user } = renderPrompt(interaction(), 'prompt', { inspiration: true });
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    expect(screen.getByText('Failure')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: REROLL }));
    expect(screen.getByText(/18 \+ 2 = 20/)).toBeInTheDocument();
    expect(screen.getByText('Success')).toBeInTheDocument();
    expect(screen.getByText('Heroic Inspiration: rerolled from 7. The new roll stands.')).toBeInTheDocument();
    // One reroll, and the first roll can't be taken back.
    expect(screen.queryByRole('button', { name: REROLL })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus());
    expect(onResolve).not.toHaveBeenCalled();

    // The roll tool reads the sheet as soon as it has the result: Inspiration must already be spent.
    let inspirationWhenResolved: boolean | undefined;
    onResolve.mockImplementation(() => {
      inspirationWhenResolved = useGame.getState().character?.heroicInspiration;
    });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(inspirationWhenResolved).toBe(false);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 18, total: 20, dc: 13, success: true }),
      manual: false,
    });
    expect(spies.updateCharacter).toHaveBeenCalledTimes(1);
    expect(spies.queueDmNotice).toHaveBeenCalledWith(
      'Player spent Heroic Inspiration to reroll Stealth check (DEX): the first roll (7) was replaced by the reroll (20), which stands.',
    );
  });

  it('continues on its own after the reroll, like any tapped roll', () => {
    vi.useFakeTimers();
    queueD20(3, 11);
    const { onResolve } = renderPrompt(interaction(), 'prompt', { inspiration: true });
    fireEvent.click(screen.getByRole('button', { name: 'Roll' }));
    fireEvent.click(screen.getByRole('button', { name: REROLL }));
    act(() => {
      vi.advanceTimersByTime(RESULT_HOLD_MS + 10);
    });
    expect(onResolve).toHaveBeenCalledWith({ result: expect.objectContaining({ natural: 11 }), manual: false });
  });

  it('with Advantage rerolls only the lower d20', async () => {
    queueD20(16, 4, 19);
    const { onResolve, user } = renderPrompt(interaction({ advantage: 'advantage' }), 'prompt', { inspiration: true });
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    expect(screen.getByText('4', { selector: 's' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: REROLL }));
    // The 16 stays; the 4 became a 19, which is kept.
    expect(screen.getByText('16', { selector: 's' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({
        natural: 19,
        total: 21,
        dice: [
          { sides: 20, value: 16, dropped: true },
          { sides: 20, value: 19 },
        ],
      }),
      manual: false,
    });
  });

  it('lets a physical-dice player reroll their own die, and the turn can no longer be cancelled', async () => {
    const { onResolve, spies, user } = renderPrompt(interaction(), 'physical', { inspiration: true });
    await user.type(screen.getByLabelText('Your d20'), '3');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    await user.click(screen.getByRole('button', { name: REROLL }));

    expect(screen.getByText('Roll your d20 again and enter the new number.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel turn' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Your d20'), '15');
    await user.click(screen.getByRole('button', { name: 'Use this roll' }));
    expect(screen.queryByRole('button', { name: REROLL })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({
      result: expect.objectContaining({ natural: 15, total: 17 }),
      manual: true,
    });
    expect(useGame.getState().character?.heroicInspiration).toBe(false);
    expect(spies.queueDmNotice).toHaveBeenCalledWith(
      'Player spent Heroic Inspiration to reroll Stealth check (DEX): the first roll (5) was replaced by the reroll (17), which stands.',
    );
  });

  it('rerolls one damage die', async () => {
    const { onResolve, user } = renderPrompt(
      interaction({ rollType: 'damage', expression: '2d6+2', dc: undefined, revealDc: false }, 0, 'Shortsword damage'),
      'prompt',
      { inspiration: true },
    );
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    await user.click(screen.getByRole('button', { name: REROLL }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    // The engine mock's other dice show 3; one of them was rolled again.
    expect(onResolve).toHaveBeenCalledWith({ result: expect.objectContaining({ total: 8 }), manual: false });
  });

  it('does not spend Inspiration when the player keeps the first roll', async () => {
    queueD20(19);
    const { onResolve, spies, user } = renderPrompt(interaction(), 'prompt', { inspiration: true });
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onResolve).toHaveBeenCalledWith({ result: expect.objectContaining({ natural: 19 }), manual: false });
    expect(spies.updateCharacter).not.toHaveBeenCalled();
    expect(spies.queueDmNotice).not.toHaveBeenCalled();
    expect(useGame.getState().character?.heroicInspiration).toBe(true);
  });
});
