import '../testing/setup';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dm } from '@/dm';
import { useGame } from '@/state/gameStore';
import { useSettings } from '@/state/settingsStore';
import { sampleLog } from '@/test/fixtures';
import type { LogEntry } from '@/types';
import { usePlayView } from '../playView';
import { sampleHomebrew } from '../testing/fakeGame';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { activeChoicesEntryId, latestErrorEntryId, NarrativeLog } from './NarrativeLog';

vi.mock('@/dm', () => import('../testing/dmMock'));

const meta = { campaignId: 'camp-1', sessionId: 'sess-1', createdAt: 1 };

const recap: LogEntry = {
  ...meta,
  id: 'log-recap',
  seq: 0.5,
  kind: 'recap',
  sessionNumber: 1,
  text: 'You came home to **Saltmarsh** the night the lantern relit itself.',
};

function renderLog(log: LogEntry[] = sampleLog()) {
  const spies = seedGame({ log });
  render(<NarrativeLog />);
  return { spies, log: screen.getByRole('log', { name: 'Story so far' }) };
}

beforeEach(() => {
  resetDmMock();
  useSettings.setState({ narrationFont: 'serif' });
});

describe('NarrativeLog', () => {
  it('renders every kind of entry in sampleLog()', () => {
    const { log } = renderLog([recap, ...sampleLog()]);

    // session divider
    expect(within(log).getByRole('heading', { name: 'Session 1' })).toBeInTheDocument();
    // recap card
    expect(within(log).getByRole('heading', { name: 'Previously…' })).toBeInTheDocument();
    // DM narration (markdown)
    expect(within(log).getByText(/Fog rolls off the water/)).toBeInTheDocument();
    expect(within(log).getByText('Saltmarsh docks').tagName).toBe('STRONG');
    // player bubble
    expect(within(log).getByText('I sit beside Tam and ask what exactly he saw that night.')).toBeInTheDocument();
    // player roll card with text outcome
    expect(within(log).getByText('Insight check')).toBeInTheDocument();
    expect(within(log).getByText('vs DC 12')).toBeInTheDocument();
    expect(within(log).getByText('Success')).toBeInTheDocument();
    // critical DM attack roll
    expect(within(log).getByText('Bandit 1 attacks Mira')).toBeInTheDocument();
    expect(within(log).getByText('vs AC 12')).toBeInTheDocument();
    expect(within(log).getByText('Critical hit')).toBeInTheDocument();
    // secret DM roll stays behind the screen
    expect(within(log).getByText('The DM rolls behind the screen')).toBeInTheDocument();
    expect(within(log).queryByText('Bandit stealth (secret)')).not.toBeInTheDocument();
    // tool lines
    expect(within(log).getByText('Journal: Old Tam (NPC) added')).toBeInTheDocument();
    expect(within(log).getByText('HP 17 → 12 (5 slashing)')).toBeInTheDocument();
    // suggested actions
    expect(within(log).getByRole('group', { name: 'Suggested actions' })).toBeInTheDocument();
    // system note
    expect(within(log).getByText(/You edited your character sheet/)).toBeInTheDocument();
    // error with Retry (it is the latest thing that happened)
    expect(within(log).getByText('The DM could not be reached (network error).')).toBeInTheDocument();
    expect(within(log).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders narration in the serif style when that setting is on', () => {
    const { log } = renderLog();
    const narration = within(log)
      .getByText(/Fog rolls off the water/)
      .closest('.narration');
    expect(narration).toHaveClass('narration-serif');
  });

  it('uses the sans narration style when the setting says so', () => {
    useSettings.setState({ narrationFont: 'sans' });
    const { log } = renderLog();
    expect(
      within(log)
        .getByText(/Fog rolls off the water/)
        .closest('.narration'),
    ).not.toHaveClass('narration-serif');
  });

  it('sends a suggested action to the DM with one tap', async () => {
    const user = userEvent.setup();
    const { log } = renderLog();
    await user.click(within(log).getByRole('button', { name: 'Pull Tam behind the nets' }));
    expect(dm.sendPlayerMessage).toHaveBeenCalledWith('Pull Tam behind the nets');
  });

  it('disables suggested actions while the DM is busy', () => {
    seedGame({ log: sampleLog(), dm: { phase: 'streaming', activity: null, error: null, retryable: false } });
    render(<NarrativeLog />);
    expect(screen.getByRole('button', { name: 'Turn and face them' })).toBeDisabled();
  });

  it('drops stale suggestions once the player has spoken', () => {
    const log = [...sampleLog(), { ...meta, id: 'p-2', seq: 50, kind: 'player', text: 'I run.' } as LogEntry];
    renderLog(log);
    expect(screen.queryByRole('group', { name: 'Suggested actions' })).not.toBeInTheDocument();
  });

  it('reveals a secret DM roll on request', async () => {
    const user = userEvent.setup();
    const { log } = renderLog();
    await user.click(within(log).getByRole('button', { name: 'Reveal' }));
    expect(within(log).getByText('Bandit stealth (secret)')).toBeInTheDocument();
    expect(within(log).getByText('Secret roll')).toBeInTheDocument();
  });

  it('shows secret DM rolls when "Reveal all DM rolls" is on or the campaign shows them', () => {
    const { log } = renderLog();
    act(() => usePlayView.getState().setRevealAllDmRolls(true));
    expect(within(log).getByText('Bandit stealth (secret)')).toBeInTheDocument();

    act(() => usePlayView.getState().setRevealAllDmRolls(false));
    expect(within(log).queryByText('Bandit stealth (secret)')).not.toBeInTheDocument();
    act(() => {
      const campaign = useGame.getState().campaign!;
      useGame.setState({ campaign: { ...campaign, settings: { ...campaign.settings, showDmRolls: true } } });
    });
    expect(within(log).getByText('Bandit stealth (secret)')).toBeInTheDocument();
  });

  it('retries the latest failed request', async () => {
    const user = userEvent.setup();
    const { log } = renderLog();
    await user.click(within(log).getByRole('button', { name: 'Retry' }));
    expect(dm.retry).toHaveBeenCalledTimes(1);
  });

  it('shows advantage dice with the dropped d20 struck through and a physical-dice badge', () => {
    const roll: LogEntry = {
      ...meta,
      id: 'adv',
      seq: 60,
      kind: 'roll',
      actor: 'player',
      purpose: 'Perception check',
      secret: false,
      manual: true,
      roll: {
        expression: '2d20kh1+3',
        total: 20,
        modifier: 3,
        breakdown: 'd20 (17, ~~4~~) + 3 = 20',
        natural: 17,
        advantage: 'advantage',
        dice: [
          { sides: 20, value: 17 },
          { sides: 20, value: 4, dropped: true },
        ],
        dc: 22,
        success: false,
      },
    };
    const { log } = renderLog([roll]);
    expect(within(log).getByText('Advantage')).toBeInTheDocument();
    expect(within(log).getByText('Failure')).toBeInTheDocument();
    expect(within(log).getByText('Physical dice')).toBeInTheDocument();
    const dropped = within(log).getByText('4', { selector: 's' });
    expect(dropped.tagName).toBe('S');
  });

  it('shows a roll against a hidden DC or AC without the target, the verdict or a telling colour', () => {
    const roll = (id: string, patch: Partial<Extract<LogEntry, { kind: 'roll' }>>): LogEntry =>
      ({ ...meta, id, seq: 61, kind: 'roll', actor: 'player', secret: false, ...patch }) as LogEntry;
    const d20 = (natural: number, modifier: number) => ({
      expression: `1d20+${modifier}`,
      total: natural + modifier,
      dice: [{ sides: 20, value: natural }],
      modifier,
      breakdown: `d20 (${natural}) + ${modifier} = ${natural + modifier}`,
      natural,
      isCritical: natural === 20,
      isFumble: natural === 1,
    });
    const { log } = renderLog([
      // The DM side leaves a hidden DC (and so the verdict) out of the logged roll.
      roll('insight', { rollType: 'skill', purpose: 'Insight check — read the stranger', roll: d20(8, 1) }),
      roll('swing', { rollType: 'attack', purpose: 'Greatsword attack', roll: d20(20, 5) }),
      // A verdict that somehow arrives without its target is not shown either.
      roll('save', { rollType: 'save', purpose: 'Wisdom saving throw', roll: { ...d20(14, 2), success: true } }),
    ]);
    expect(within(log).queryByText(/^vs /)).not.toBeInTheDocument();
    expect(within(log).queryByText(/^(Success|Failure|Hit|Miss)$/)).not.toBeInTheDocument();
    // Natural 20s are rules facts, not the DM's verdict.
    expect(within(log).getByText('Critical hit')).toBeInTheDocument();
    expect(within(log).getByText('9')).toHaveClass('text-text');
    expect(within(log).getByText('16')).toHaveClass('text-text');
  });

  it('expands tool details and offers View and Veto on homebrew lines', async () => {
    const user = userEvent.setup();
    const line: LogEntry = {
      ...meta,
      id: 'hb',
      seq: 70,
      kind: 'tool',
      tool: 'create_homebrew',
      icon: 'homebrew',
      summary: "Homebrew created: Tidecaller's Mark (boon)",
      detail: 'Breathe water for **10 minutes**.',
    };
    const spies = seedGame({ log: [line], homebrew: sampleHomebrew() });
    render(<NarrativeLog />);

    await user.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('10 minutes').tagName).toBe('STRONG');

    await user.click(screen.getByRole('button', { name: "View homebrew Tidecaller's Mark" }));
    const viewer = screen.getByRole('heading', { name: "Tidecaller's Mark" }).closest('dialog')!;
    expect(within(viewer).getByText(/Narrower than the 3rd-level spell/)).toBeInTheDocument();
    await user.click(within(viewer).getByRole('button', { name: 'Close' }));

    await user.click(screen.getByRole('button', { name: "Veto homebrew Tidecaller's Mark" }));
    expect(spies.queueDmNotice).toHaveBeenCalledWith(
      'The player vetoed homebrew "Tidecaller\'s Mark". Retire or rework it.',
    );
    expect(screen.getByRole('button', { name: "Vetoed homebrew Tidecaller's Mark" })).toBeDisabled();
  });

  it('keeps the DM notes collapsed behind a spoiler warning', () => {
    const entry: LogEntry = {
      ...meta,
      id: 'r',
      seq: 80,
      kind: 'dm',
      text: 'The door creaks.',
      reasoning: 'The cult waits inside.',
    };
    renderLog([entry]);
    const summary = screen.getByText(/DM's notes \(may contain spoilers\)/);
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
  });

  it('shows a caret while narration streams and announces it only once finished', () => {
    const streaming: LogEntry = { ...meta, id: 'live', seq: 90, kind: 'dm', text: 'The fog', streaming: true };
    seedGame({ log: [...sampleLog(), streaming] });
    render(<NarrativeLog />);
    const article = screen.getByText('The fog').closest('article')!;
    expect(article).toHaveAttribute('aria-busy', 'true');
    const announcer = document.querySelector('[aria-live="polite"]')!;
    expect(announcer).toHaveTextContent('');

    act(() => {
      useGame.setState({
        log: useGame
          .getState()
          .log.map((e) => (e.id === 'live' ? { ...e, text: 'The fog *parts*.', streaming: false } : e)),
      });
    });
    expect(announcer).toHaveTextContent('The DM: The fog parts.');
    expect(screen.getByText('parts').closest('article')).not.toHaveAttribute('aria-busy');
  });

  it('is a log region that does not live-announce its contents', () => {
    const { log } = renderLog();
    expect(log).toHaveAttribute('aria-live', 'off');
  });

  it('shows an empty state before the story begins', () => {
    renderLog([]);
    expect(screen.getByText('The story is about to begin')).toBeInTheDocument();
  });
});

describe('log helpers', () => {
  it('finds the DM entry whose choices are still current', () => {
    const log = sampleLog();
    const withChoices = log.find((e) => e.kind === 'dm' && e.choices)!;
    expect(activeChoicesEntryId(log)).toBe(withChoices.id);
    const later: LogEntry = { ...meta, id: 'dm-2', seq: 99, kind: 'dm', text: 'Next.' };
    expect(activeChoicesEntryId([...log, later])).toBeNull();
  });

  it('only treats an error as retryable while nothing happened after it', () => {
    const log = sampleLog();
    const error = log.find((e) => e.kind === 'error')!;
    expect(latestErrorEntryId(log)).toBe(error.id);
    const player: LogEntry = { ...meta, id: 'p', seq: 99, kind: 'player', text: 'Hello' };
    expect(latestErrorEntryId([...log, player])).toBeNull();
  });
});
