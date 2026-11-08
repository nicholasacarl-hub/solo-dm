import './testing/setup';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import type { InteractionRequest, InteractionResponse } from '@/types';
import { InteractionHost } from './InteractionHost';
import { resetDmMock } from './testing/dmMock';
import { queueD20, resetEngineMock } from './testing/engineMock';
import { seedGame } from './testing/seed';

vi.mock('@/dm', () => import('./testing/dmMock'));
vi.mock('@/engine', () => import('./testing/engineMock'));
vi.mock('@/ui/sheet/ShortRestDialog', () => ({
  ShortRestDialog: ({ onDone, onCancel }: { onDone: (r: { spent: [] }) => void; onCancel: () => void }) => (
    <div>
      <p>Short rest dialog</p>
      <button type="button" onClick={() => onDone({ spent: [] })}>
        Finish rest
      </button>
      <button type="button" onClick={onCancel}>
        Skip rest
      </button>
    </div>
  ),
}));

beforeEach(() => {
  resetDmMock();
  resetEngineMock();
  useSettings.setState({ diceAnimations: false });
});

/** Seed the store and ask for an interaction the way a DM tool does; returns the pending answer. */
function request(interaction: InteractionRequest) {
  const spies = seedGame();
  render(<InteractionHost />);
  let answer: Promise<InteractionResponse> | undefined;
  act(() => {
    answer = useGame.getState().requestInteraction(interaction);
  });
  return { spies, answer: answer!, user: userEvent.setup() };
}

describe('InteractionHost', () => {
  it('renders nothing while the DM is not waiting on the player', () => {
    seedGame();
    const { container } = render(<InteractionHost />);
    expect(container).toBeEmptyDOMElement();
  });

  it('asks the player to roll in the campaign roll mode and hands the result back', async () => {
    queueD20(14);
    const { answer, spies, user } = request({
      kind: 'roll',
      id: 'r1',
      modifier: 3,
      label: 'Athletics check (STR)',
      request: {
        rollType: 'skill',
        skill: 'athletics',
        dc: 12,
        revealDc: true,
        advantage: 'normal',
        reason: 'Climb the wet stones',
      },
    });
    expect(screen.getByRole('heading', { name: 'Athletics check (STR)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Roll' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(spies.resolveInteraction).toHaveBeenCalledWith('r1', expect.objectContaining({ kind: 'roll' }));
    await expect(answer).resolves.toEqual({
      kind: 'roll',
      response: { result: expect.objectContaining({ natural: 14, total: 17, success: true }), manual: false },
    });
    expect(screen.queryByRole('heading', { name: 'Athletics check (STR)' })).not.toBeInTheDocument();
  });

  it('uses physical dice when the campaign is set to them', () => {
    const spies = seedGame();
    const campaign = useGame.getState().campaign!;
    useGame.setState({ campaign: { ...campaign, settings: { ...campaign.settings, playerRollMode: 'physical' } } });
    render(<InteractionHost />);
    act(() => {
      void spies.requestInteraction({
        kind: 'roll',
        id: 'r2',
        modifier: 0,
        label: 'Death saving throw',
        request: { rollType: 'death-save', revealDc: true, advantage: 'normal', reason: 'You are dying' },
      });
    });
    expect(screen.getByLabelText('Your d20')).toBeInTheDocument();
    expect(screen.getByText('DC 10')).toBeInTheDocument();
  });

  it('stops the DM turn from the roll prompt', async () => {
    const { user } = request({
      kind: 'roll',
      id: 'r3',
      modifier: 1,
      label: 'Insight check (WIS)',
      request: { rollType: 'skill', skill: 'insight', revealDc: false, advantage: 'normal', reason: 'Is he lying?' },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel turn' }));
    expect(dm.cancel).toHaveBeenCalledTimes(1);
  });

  it('confirms or declines a DM question', async () => {
    const { answer, user } = request({
      kind: 'confirm',
      id: 'c1',
      title: 'Spend a Hit Die?',
      body: 'You have **2** left.',
      confirmLabel: 'Spend it',
    });
    expect(screen.getByRole('heading', { name: 'Spend a Hit Die?' })).toBeInTheDocument();
    expect(screen.getByText('2').tagName).toBe('STRONG');
    await user.click(screen.getByRole('button', { name: 'Spend it' }));
    await expect(answer).resolves.toEqual({ kind: 'confirm', confirmed: true });

    act(() => {
      void useGame
        .getState()
        .requestInteraction({ kind: 'confirm', id: 'c2', title: 'Open the door?', body: 'It is warm.' });
    });
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(useGame.getState().interaction).toBeNull();
  });

  // The battle map's hero-as-reactor question (D32): the first tool to use `confirm` (R7).
  it("asks about an Opportunity Attack the way move_tokens does: title, body, both labels; Let it go answers false and the dialog can't be dismissed by accident", async () => {
    const { answer, user } = request({
      kind: 'confirm',
      id: 'oa1',
      title: 'Opportunity Attack',
      body: 'Bandit 1 is leaving your reach (from C5). Use your Reaction to make one melee attack against it?',
      confirmLabel: 'Attack',
      cancelLabel: 'Let it go',
    });
    const dialog = screen.getByRole('dialog', { name: 'Opportunity Attack' });
    expect(dialog).toHaveTextContent('Bandit 1 is leaving your reach (from C5). Use your Reaction to make one melee attack against it?');
    expect(screen.getByRole('button', { name: 'Attack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Let it go' })).toBeInTheDocument();
    // The DM is waiting on the answer: no close button, and Escape doesn't close it.
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    // What a browser's Escape does to a modal <dialog> (jsdom doesn't): a cancel event, refused here.
    act(() => {
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    });
    expect(useGame.getState().interaction).not.toBeNull();
    expect(screen.getByRole('dialog', { name: 'Opportunity Attack' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Let it go' }));
    await expect(answer).resolves.toEqual({ kind: 'confirm', confirmed: false });
    expect(useGame.getState().interaction).toBeNull();

    let second: Promise<InteractionResponse> | undefined;
    act(() => {
      second = useGame.getState().requestInteraction({
        kind: 'confirm',
        id: 'oa2',
        title: 'Opportunity Attack',
        body: 'The Dock Ogre is leaving your reach (from B6).',
        confirmLabel: 'Attack',
        cancelLabel: 'Let it go',
      });
    });
    await user.click(screen.getByRole('button', { name: 'Attack' }));
    await expect(second).resolves.toEqual({ kind: 'confirm', confirmed: true });
  });

  it('hands short rests to the sheet dialog and reports cancellation', async () => {
    const { answer, spies, user } = request({
      kind: 'short-rest',
      id: 's1',
      hitDice: [{ die: 6, total: 3, spent: 1 }],
      conMod: 1,
    });
    expect(screen.getByText('Short rest dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Finish rest' }));
    await expect(answer).resolves.toEqual({ kind: 'short-rest', response: { spent: [] } });

    let second: Promise<InteractionResponse> | undefined;
    act(() => {
      second = useGame.getState().requestInteraction({ kind: 'short-rest', id: 's2', hitDice: [], conMod: 0 });
    });
    await user.click(screen.getByRole('button', { name: 'Skip rest' }));
    expect(spies.cancelInteraction).toHaveBeenCalledWith('s2', 'The player cancelled the short rest.');
    await expect(second).rejects.toThrow();
  });
});
