import './testing/setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RulesIndex, SearchHit } from '@/data';
import type { CompendiumEntry } from '@/types';
import { usePlayView } from './playView';
import { RulesPanel } from './RulesPanel';
import { seedGame } from './testing/seed';

const grappled: CompendiumEntry = {
  id: 'srd:condition:grappled',
  sourceId: 'srd-5.2.1',
  sourceName: 'SRD 5.2.1',
  kind: 'condition',
  name: 'Grappled',
  summary: 'Speed 0; disadvantage on attacks against others.',
  text: "While Grappled, your **Speed is 0** and can't increase.",
  path: ['Rules Glossary', 'Grappled'],
};

const index = vi.hoisted(() => ({ current: null as RulesIndex | null }));
vi.mock('@/data', () => ({ useRulesIndex: () => index.current }));

function fakeIndex(hits: SearchHit[]): RulesIndex {
  return {
    search: vi.fn(() => hits),
    get: () => undefined,
    findByName: () => undefined,
    list: () => [],
    sources: () => [],
  };
}

beforeEach(() => {
  index.current = fakeIndex([{ entry: grappled, score: 1, snippet: 'While Grappled…' }]);
  seedGame();
});

describe('RulesPanel', () => {
  it('waits for the rules index to load', () => {
    index.current = null;
    render(<RulesPanel />);
    expect(screen.getByText('Loading the rules…')).toBeInTheDocument();
  });

  it('searches the rules and opens an entry', async () => {
    const user = userEvent.setup();
    render(<RulesPanel />);
    await user.type(screen.getByRole('searchbox', { name: 'Search the rules' }), 'grapple');

    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(index.current!.search).toHaveBeenLastCalledWith('grapple', {
      campaignId: 'camp-1',
      limit: 30,
      kinds: undefined,
    });
    await user.click(within(results).getByRole('button', { name: /Grappled/ }));

    const dialog = screen.getByRole('heading', { name: 'Grappled' }).closest('dialog')!;
    expect(within(dialog).getByText('Speed is 0').tagName).toBe('STRONG');
    expect(within(dialog).getByText('Rules Glossary › Grappled')).toBeInTheDocument();
  });

  it('filters by kind', async () => {
    const user = userEvent.setup();
    render(<RulesPanel />);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'spell');
    await user.type(screen.getByRole('searchbox', { name: 'Search the rules' }), 'fire');
    await waitFor(() =>
      expect(index.current!.search).toHaveBeenLastCalledWith('fire', expect.objectContaining({ kinds: ['spell'] })),
    );
  });

  it('offers suggestions and says when nothing matches', async () => {
    const user = userEvent.setup();
    index.current = fakeIndex([]);
    render(<RulesPanel />);
    await user.click(screen.getByRole('button', { name: 'Concentration' }));
    expect(screen.getByRole('searchbox', { name: 'Search the rules' })).toHaveValue('Concentration');
    expect(await screen.findByText('No matches')).toBeInTheDocument();
  });

  it('asks the DM about a rule out of character', async () => {
    const user = userEvent.setup();
    const onAskDm = vi.fn();
    render(<RulesPanel onAskDm={onAskDm} />);
    await user.type(screen.getByRole('searchbox', { name: 'Search the rules' }), 'grapple');
    await user.click(await screen.findByRole('button', { name: /Grappled/ }));
    await user.click(screen.getByRole('button', { name: 'Ask the DM about this' }));
    expect(usePlayView.getState().prefill?.text).toBe('OOC: About Grappled: ');
    expect(onAskDm).toHaveBeenCalledTimes(1);
  });
});
