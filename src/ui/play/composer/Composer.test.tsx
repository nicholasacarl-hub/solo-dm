import '../testing/setup';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { resetDmMock } from '../testing/dmMock';
import { resetEngineMock } from '../testing/engineMock';
import { seedGame } from '../testing/seed';
import { setMatchMedia, TOUCH } from '../testing/setup';
import { Composer } from './Composer';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/ui/sheet/LevelUpDialog', () => ({ LevelUpDialog: () => null }));

function setup() {
  const user = userEvent.setup();
  const spies = seedGame();
  render(<Composer />);
  const box = screen.getByRole('textbox', { name: 'What do you do?' });
  return { user, spies, box };
}

beforeEach(() => {
  resetDmMock();
  resetEngineMock();
});

describe('Composer', () => {
  it('sends with Enter on desktop and adds a line with Shift+Enter', async () => {
    const { user, box } = setup();
    await user.type(box, 'I search the nets{Shift>}{Enter}{/Shift}for anything odd');
    expect(box).toHaveValue('I search the nets\nfor anything odd');
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('I search the nets\nfor anything odd');
    expect(box).toHaveValue('');
  });

  it('does not send empty messages', async () => {
    const { user, box } = setup();
    await user.type(box, '   {Enter}');
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('on touch devices Enter adds a line and the Send button sends', async () => {
    setMatchMedia(TOUCH);
    const { user, box } = setup();
    await user.type(box, 'I wait{Enter}and listen');
    expect(box).toHaveValue('I wait\nand listen');
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('I wait\nand listen');
  });

  it('shows Stop instead of Send while the DM is busy', async () => {
    const { user, box } = setup();
    act(() => useGame.setState({ dm: { phase: 'streaming', activity: null, error: null, retryable: false } }));
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    await user.type(box, 'Hold on{Enter}');
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(dm.cancel).toHaveBeenCalledTimes(1);
  });

  it('prefixes "OOC: " when the OOC toggle is on', async () => {
    const { user } = setup();
    const toggle = screen.getByRole('button', { name: 'OOC' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const box = screen.getByRole('textbox', { name: 'Out-of-character message to the DM' });
    await user.type(box, 'Is Shield a reaction?{Enter}');
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('OOC: Is Shield a reaction?');
  });

  it('gives the words back if the DM refuses the message', async () => {
    vi.mocked(dm.sendPlayerMessage).mockRejectedValueOnce(new Error('No session is running.'));
    const { user, box } = setup();
    await user.type(box, 'Hello?{Enter}');
    await waitFor(() => expect(box).toHaveValue('Hello?'));
  });

  it('plays the X-card: optional veil, then the steer-away message', async () => {
    const { user, spies } = setup();
    await user.click(screen.getByRole('button', { name: /X-card/ }));
    const popover = screen.getByRole('dialog', { name: 'X-card' });
    await user.type(within(popover).getByLabelText('Also add a veil:'), 'drowning');
    await user.click(within(popover).getByRole('button', { name: 'Steer away from this' }));

    await waitFor(() =>
      expect(dm.sendPlayerMessage).toHaveBeenCalledWith('[X-card] Please steer away from the current content.'),
    );
    expect(spies.updateCampaign).toHaveBeenCalledTimes(1);
    expect(useGame.getState().campaign?.settings.veils).toEqual(['Torture', 'drowning']);
    expect(spies.queueDmNotice).toHaveBeenCalledWith(expect.stringContaining('"drowning"'));
    expect(screen.queryByRole('dialog', { name: 'X-card' })).not.toBeInTheDocument();
  });

  it('plays the X-card without a veil and stops a busy DM first', async () => {
    const { user, spies } = setup();
    act(() => useGame.setState({ dm: { phase: 'streaming', activity: null, error: null, retryable: false } }));
    vi.mocked(dm.cancel).mockImplementation(() =>
      useGame.setState({ dm: { phase: 'idle', activity: null, error: null, retryable: false } }),
    );

    await user.click(screen.getByRole('button', { name: /X-card/ }));
    await user.click(screen.getByRole('button', { name: 'Steer away from this' }));

    await waitFor(() =>
      expect(dm.sendPlayerMessage).toHaveBeenCalledWith('[X-card] Please steer away from the current content.'),
    );
    expect(dm.cancel).toHaveBeenCalledTimes(1);
    expect(spies.updateCampaign).not.toHaveBeenCalled();
  });

  it('rolls dice from the quick actions, logs the roll and tells the DM', async () => {
    const { user, spies } = setup();
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Roll dice…' }));

    const dialog = screen.getByRole('heading', { name: 'Roll dice' }).closest('dialog')!;
    const dice = within(dialog).getByLabelText('Dice');
    await user.clear(dice);
    await user.type(dice, '2d6+1');
    await user.type(within(dialog).getByLabelText("What's it for?"), 'Fishing');
    await user.click(within(dialog).getByRole('button', { name: 'Roll' }));

    await waitFor(() => expect(spies.appendLog).toHaveBeenCalledTimes(1));
    expect(spies.appendLog).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'roll',
        actor: 'player',
        purpose: 'Fishing',
        secret: false,
        roll: expect.objectContaining({ total: 7 }),
      }),
    );
    expect(spies.queueDmNotice).toHaveBeenCalledWith('The player rolled 2d6+1 for "Fishing" on their own: 2d6+1 = 7.');
  });

  it('explains bad dice instead of rolling', async () => {
    const { user, spies } = setup();
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Roll dice…' }));
    const dialog = screen.getByRole('heading', { name: 'Roll dice' }).closest('dialog')!;
    const dice = within(dialog).getByLabelText('Dice');
    await user.clear(dice);
    await user.type(dice, 'banana');
    await user.click(within(dialog).getByRole('button', { name: 'Roll' }));
    expect(within(dialog).getByText(/Couldn't read 'banana'/)).toBeInTheDocument();
    expect(spies.appendLog).not.toHaveBeenCalled();
  });

  it('prefills "OOC: " for a rules question and asks for rests in character', async () => {
    const { user, box } = setup();
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Ask a rules question/ }));
    expect(box).toHaveValue('OOC: ');
    expect(box).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Short rest' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith("I'd like to take a short rest.");

    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Long rest' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith("I'd like to take a long rest.");
  });

  it('opens the quick actions menu from the keyboard', async () => {
    const { user } = setup();
    screen.getByRole('button', { name: 'Quick actions' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Roll dice…' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /Ask a rules question/ })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick actions' })).toHaveFocus();
  });
});
