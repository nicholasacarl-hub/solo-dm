/**
 * Seed the real game store with fixtures and spy-wrapped fake actions, so tests can render the
 * Play screen without IndexedDB or the DM and assert on store calls.
 */
import { vi, type Mock } from 'vitest';
import { useGame, type GameStoreActions, type GameStoreState } from '@/state/gameStore';
import { createFakeActions, fixtureState } from './fakeGame';

export type ActionSpies = { [K in keyof GameStoreActions]: Mock<GameStoreActions[K]> };

export function seedGame(overrides: Partial<GameStoreState> = {}): ActionSpies {
  const fakes = createFakeActions();
  const spies: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(fakes)) spies[name] = vi.fn(fn);
  useGame.setState({ ...fixtureState(), ...overrides, ...spies });
  return spies as unknown as ActionSpies;
}
