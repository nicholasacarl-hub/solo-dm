import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useSettings } from '@/state/settingsStore';
import { appRoutes } from './routes';
import { autoCleanup } from './testUtils';
import { useAppearance } from './useAppearance';

vi.mock('@/ui/screens/HomeScreen', () => ({
  HomeScreen: () => {
    throw new Error('Home exploded');
  },
}));
vi.mock('@/storage', () => ({
  useCampaignList: () => [],
  useLibrarySources: () => [],
  useHomebrewList: () => [],
}));
vi.mock('@/data', () => ({
  SRD_ATTRIBUTION: 'This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1").',
  loadSrdManifest: () => Promise.reject(new Error('offline')),
  useRulesIndexState: () => ({ index: null, loading: true, error: null }),
  invalidateRulesIndex: () => {},
}));
vi.mock('@/state/gameStore', () => ({ useGame: { getState: () => ({ campaignId: null }) } }));

autoCleanup();

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('app routes', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps screens in the layout with the main navigation', () => {
    renderAt('/settings');
    expect(screen.getByRole('link', { name: 'Solo DM' })).toHaveAttribute('href', '/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Library' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it('shows a friendly not-found page for unknown addresses', () => {
    renderAt('/nowhere/at/all');
    expect(screen.getByRole('heading', { name: 'Lost in the fog' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to campaigns/ })).toHaveAttribute('href', '/');
  });

  it('lazy-loads the library and keeps the tab in the URL', async () => {
    renderAt('/library?tab=about');
    expect(await screen.findByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /About/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  });

  it('contains a crashing page so the top bar keeps working', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: 'This page ran into a problem' })).toBeInTheDocument();
    expect(screen.getByText(/Home exploded/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Campaigns' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('useAppearance', () => {
  function Probe() {
    useAppearance();
    return null;
  }

  it('applies theme, text size and narration font to <html>', () => {
    localStorage.clear();
    useSettings.getState().reset();
    render(<Probe />);
    const root = document.documentElement;
    expect(root.dataset.textSize).toBe('md');

    act(() => useSettings.getState().update({ theme: 'dark', textSize: 'lg', narrationFont: 'sans' }));
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.textSize).toBe('lg');
    expect(root.dataset.narrationFont).toBe('sans');

    act(() => useSettings.getState().update({ theme: 'light' }));
    expect(root.dataset.theme).toBe('light');
  });
});
