import '../testing/setup';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import type { CombatState, GridPoint, TranscriptMessage, TurnMove } from '@/types';
import { usePlayView } from '../playView';
import { resetDmMock } from '../testing/dmMock';
import { resetEngineMock } from '../testing/engineMock';
import { resetImagesMock, withImages } from '../testing/imagesMock';
import { seedGame } from '../testing/seed';
import { setMatchMedia, TOUCH } from '../testing/setup';
import { Composer } from './Composer';
import { SHOW_SCENE_MESSAGE } from './QuickActions';
import { END_TURN_WORDS, emptySendWords, endTurn } from './turnWords';

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/images', () => import('../testing/imagesMock'));
vi.mock('@/ui/sheet/LevelUpDialog', () => ({ LevelUpDialog: () => null }));

function setup(state: Parameters<typeof seedGame>[0] = {}) {
  const user = userEvent.setup();
  const spies = seedGame(state);
  render(
    <MemoryRouter>
      <Composer />
    </MemoryRouter>,
  );
  const box = screen.getByRole('textbox', { name: 'What do you do?' });
  return { user, spies, box };
}

beforeEach(() => {
  resetDmMock();
  resetEngineMock();
  resetImagesMock();
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

  it('uses 16px text on phones and touch screens, so iOS Safari does not zoom in on focus', () => {
    const { box } = setup();
    // Below the sm breakpoint everywhere; 15px from sm up on pointer devices only.
    expect(box).toHaveClass('text-base', 'sm:text-[0.9375rem]');
    cleanup();
    setMatchMedia(TOUCH);
    const touch = setup().box;
    expect(touch).toHaveClass('text-base');
    expect(touch).not.toHaveClass('sm:text-[0.9375rem]');
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

  it('asks the DM to show the scene when pictures can be made', async () => {
    withImages();
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    const item = screen.getByRole('menuitem', { name: /Show me the scene/ });
    expect(item).toHaveTextContent('OOC');
    await user.click(item);
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith(SHOW_SCENE_MESSAGE);
    expect(SHOW_SCENE_MESSAGE).toBe('OOC: Please show me an image of the current scene.');
  });

  it('does not ask for the scene while the DM is busy', async () => {
    withImages();
    const { user } = setup();
    act(() => useGame.setState({ dm: { phase: 'streaming', activity: null, error: null, retryable: false } }));
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    expect(screen.getByRole('menuitem', { name: /Show me the scene/ })).toBeDisabled();
  });

  it('explains how to turn illustrations on instead of asking when they are off', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    const item = screen.getByRole('menuitem', { name: /Show me the scene/ });
    expect(item).toHaveTextContent('Set up');
    await user.click(item);

    const dialog = screen.getByRole('dialog', { name: 'Turn on illustrations' });
    expect(dialog).toHaveAccessibleDescription('Illustrations need your own OpenAI API key, added in Settings.');
    expect(within(dialog).getByText(/a few cents/)).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings#settings-section-images');
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog', { name: 'Turn on illustrations' })).not.toBeInTheDocument();
  });

  it('says when illustrations are switched off rather than missing a key', async () => {
    withImages('off');
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Quick actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Show me the scene/ }));
    expect(screen.getByRole('dialog', { name: 'Turn on illustrations' })).toHaveAccessibleDescription(
      'Illustrations are turned off in Settings.',
    );
  });
});

describe('Composer: requests from the battle map', () => {
  it('focuses itself on a focus request ("Tell the DM") without touching the draft', () => {
    const { box } = setup();
    act(() => usePlayView.getState().setDraft('I draw my dagger'));
    act(() => box.blur());
    act(() => usePlayView.getState().focusComposer());
    expect(box).toHaveFocus();
    expect(box).toHaveValue('I draw my dagger');
    expect((box as HTMLTextAreaElement).selectionStart).toBe('I draw my dagger'.length);
  });

  it('ignores a focus request made before it mounted (it remounts across the desktop breakpoint)', () => {
    usePlayView.setState({ composerFocus: 3, draft: 'Hold the line' });
    const { box } = setup();
    expect(box).not.toHaveFocus();
    expect(box).toHaveValue('Hold the line');
  });

  it('shows an [Area: …] line added to the draft on its own line, and focuses', async () => {
    const { user, box } = setup();
    await user.type(box, 'I cast Burning Hands!');
    act(() => box.blur());
    const area = '[Area: Burning Hands — 15-ft cone from Mira Voss toward C5; on my map it catches Bandit 1]';
    act(() => usePlayView.getState().appendToDraft(area));
    expect(box).toHaveValue(`I cast Burning Hands!\n${area}`);
    expect(box).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith(`I cast Burning Hands!\n${area}`);
  });
});

describe("Composer: an empty Send on the hero's map turn (spec §7.4)", () => {
  const B6 = { x: 1, y: 5 };
  const message = (seq: number, role: 'user' | 'assistant'): TranscriptMessage => ({
    id: `t-${seq}`,
    sessionId: 'sess-1',
    seq,
    param: role === 'user' ? { role, content: 'I move.' } : { role, content: [{ type: 'text', text: 'You move.' }] },
    createdAt: seq,
  });

  /** The hero's turn on the warehouse map after the player moved the hero to `at` (not yet told to the DM). */
  function movedTo(at: GridPoint, patch: Partial<TurnMove> = {}): CombatState {
    const state = sampleMappedCombat({ heroTurn: true });
    const move: TurnMove = { by: 'player', kind: 'move', from: B6, to: at, path: [at], costFt: 10, provoked: [], entered: [], ...patch };
    return {
      ...state,
      combatants: state.combatants.map((c) => (c.isPlayer ? { ...c, position: at } : c)),
      map: state.map && {
        ...state.map,
        turn: { combatantId: 'c-1', round: 2, movedFt: move.costFt, dashFt: 0, dashes: 0, disengaged: false, stoodUp: false, moves: [move] },
      },
    };
  }

  it('sends "I move to D8." when the hero moved and the draft is empty', async () => {
    const { user } = setup({ combat: movedTo({ x: 3, y: 7 }) });
    const box = screen.getByRole('textbox', { name: 'What do you do?' });
    expect(box).toHaveAttribute('placeholder', 'I move to D8.');
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeEnabled();
    await user.click(send);
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('I move to D8.');
  });

  it('names the place the hero ended in, keeps typed words first, and keeps OOC for typed words only', async () => {
    const { user, box } = setup({ combat: movedTo({ x: 0, y: 6 }) });
    await user.click(screen.getByRole('button', { name: 'OOC' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(dm.sendPlayerMessage).toHaveBeenLastCalledWith('I move to A7, by the loading door.');

    await user.type(box, 'How far is the ogre?{Enter}');
    expect(dm.sendPlayerMessage).toHaveBeenLastCalledWith('OOC: How far is the ogre?');
  });

  it("says 'I keep moving to A7.' while the hero's stop is waiting for the DM", async () => {
    const { user } = setup({ combat: sampleStopCombat() });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('I keep moving to A7.');
  });

  it('says "I stand up." when the hero only stood up', () => {
    const combat = movedTo(B6, { kind: 'stand', to: B6, path: [], costFt: 15 });
    expect(emptySendWords(combat, [])).toBe('I stand up.');
  });

  it('has nothing to say once the DM has answered the message that carried the moves, or on another turn', () => {
    const told = movedTo({ x: 3, y: 7 }, { toldSeq: 1 });
    expect(emptySendWords(told, [message(1, 'user')])).toBe('I move to D8.');
    expect(emptySendWords(told, [message(1, 'user'), message(2, 'assistant')])).toBeNull();
    setup({ combat: told, transcript: [message(1, 'user'), message(2, 'assistant')] });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'What do you do?' })).toHaveAttribute('placeholder', 'What do you do?');

    expect(emptySendWords({ ...movedTo({ x: 3, y: 7 }), turnIndex: 1 }, [])).toBeNull();
    expect(emptySendWords(sampleMappedCombat({ heroTurn: true }), [])).toBeNull();
    expect(emptySendWords(null, [])).toBeNull();
  });
});

describe('End turn', () => {
  it('sends "I end my turn." with an empty draft', async () => {
    seedGame();
    await endTurn();
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith(END_TURN_WORDS);
    expect(END_TURN_WORDS).toBe('I end my turn.');
  });

  it('adds it to a draft with words in it (never sends or discards them), and while the DM is busy', async () => {
    const { box } = setup();
    act(() => usePlayView.getState().setDraft('I shove the bandit'));
    await act(() => endTurn());
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();
    expect(box).toHaveValue('I shove the bandit\nI end my turn.');
    expect(box).toHaveFocus();

    act(() => {
      usePlayView.getState().setDraft('');
      useGame.setState({ dm: { phase: 'streaming', activity: null, error: null, retryable: false } });
    });
    await act(() => endTurn());
    expect(dm.sendPlayerMessage).not.toHaveBeenCalled();
    expect(usePlayView.getState().draft).toBe('I end my turn.');
  });
});
