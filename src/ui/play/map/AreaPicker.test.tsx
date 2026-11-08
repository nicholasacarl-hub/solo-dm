import '../testing/setup';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RulesIndex } from '@/data';
import { sampleCharacter, sampleMappedCombat } from '@/test/fixtures';
import type { Character, CombatState, CompendiumEntry } from '@/types';
import { usePlayView } from '../playView';
import { resetDmMock } from '../testing/dmMock';
import { seedGame } from '../testing/seed';
import { DESKTOP, setMatchMedia, stubBoundingRect } from '../testing/setup';
import { BattleMapPanel } from './BattleMapPanel';
import { resetShownBudgetForTests } from './model';

const mocks = vi.hoisted(() => ({ index: null as RulesIndex | null }));

vi.mock('@/dm', () => import('../testing/dmMock'));
vi.mock('@/engine', () => import('../testing/engineMock'));
vi.mock('@/data', () => ({ useRulesIndex: () => mocks.index }));

function spell(id: string, name: string, range: string, text: string): CompendiumEntry {
  return { id, sourceId: 'srd', sourceName: 'SRD 5.2.1', kind: 'spell', name, text: `- **Range:** ${range}\n\n${text}`, data: { range } };
}

const SPELLS = [
  spell('srd:spell:burning-hands', 'Burning Hands', 'Self', 'Each creature in a 15-foot Cone makes a Dexterity saving throw.'),
  spell('srd:spell:fireball', 'Fireball', '150 feet', 'Each creature in a 20-foot-radius Sphere centered on that point makes a Dexterity saving throw.'),
  spell('srd:spell:shatter', 'Shatter', '60 feet', 'Each creature in a 10-foot-radius Sphere centered on a point you choose within range makes a Constitution saving throw.'),
];

function caster(): Character {
  const base = sampleCharacter();
  const sc = base.spellcasting as NonNullable<Character['spellcasting']>;
  return {
    ...base,
    spellcasting: {
      ...sc,
      spells: [
        ...sc.spells,
        { id: 'srd:spell:burning-hands', name: 'Burning Hands', level: 1, prepared: true, source: 'Wizard' },
        { id: 'srd:spell:fireball', name: 'Fireball', level: 3, prepared: true, source: 'Wizard' },
        { id: 'srd:spell:shatter', name: 'Shatter', level: 2, prepared: true, source: 'Wizard' },
      ],
    },
  };
}

function heroTurnWithBanditAdjacent(): CombatState {
  const base = sampleMappedCombat({ heroTurn: true });
  return { ...base, combatants: base.combatants.map((c) => (c.id === 'c-2' ? { ...c, position: { x: 2, y: 4 } } : c)) };
}

function renderArea(combat: CombatState = sampleMappedCombat({ heroTurn: true })) {
  seedGame({ combat, character: caster() });
  render(<BattleMapPanel variant="dock" />);
  return userEvent.setup();
}

const app = () => screen.getByRole('application');
const readout = () => screen.getByTestId('area-readout');

async function enterOn(x: number, y: number) {
  act(() => usePlayView.getState().setCursor({ x, y }));
  await act(async () => {
    fireEvent.keyDown(app(), { key: 'Enter' });
  });
}

async function pick(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('radio', { name: /Area/ }));
  const dialog = screen.getByRole('dialog', { name: 'Area of effect' });
  await user.click(within(dialog).getByRole('button', { name }));
}

beforeEach(() => {
  resetDmMock();
  resetShownBudgetForTests();
  mocks.index = {
    search: () => [],
    get: (id) => SPELLS.find((s) => s.id === id),
    findByName: () => undefined,
    list: () => SPELLS,
    sources: () => [],
  };
  setMatchMedia(DESKTOP);
  stubBoundingRect(640, 480);
});

describe('area templates (D50, D64)', () => {
  it('offers the hero’s prepared area spells, parsed from their text, and Custom', async () => {
    const user = renderArea();
    await user.click(screen.getByRole('radio', { name: /Area/ }));
    const dialog = screen.getByRole('dialog', { name: 'Area of effect' });
    const yours = within(dialog).getByRole('region', { name: 'Your spells' });
    expect(within(yours).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Burning Hands15-ft cone from you',
      'Fireball20-ft sphere · range 150 ft',
      'Shatter10-ft sphere · range 60 ft',
    ]);
    expect(within(dialog).getByRole('region', { name: 'Custom area' })).toBeInTheDocument();
  });

  it('places a Fireball by tapping, snaps to a corner, and adds exactly one [Area: …] line to the message', async () => {
    const user = renderArea();
    await pick(user, /Fireball/);
    expect(app().querySelector('[data-map-layer="template"]')).not.toBeNull();
    await enterOn(6, 3); // G4
    expect(readout()).toHaveTextContent('Fireball · 20-ft sphere centred on G4 · catches Bandit 1 and Bandit 2');

    await user.click(screen.getByRole('radio', { name: 'Corner' }));
    expect(readout()).toHaveTextContent('Fireball · 20-ft sphere centred on G4/H5 ·');
    await user.click(screen.getByRole('radio', { name: 'Snap: square' }));
    expect(readout()).toHaveTextContent('centred on G4 ·');

    act(() => usePlayView.getState().setDraft('I hurl it at them!'));
    await user.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(usePlayView.getState().draft).toBe('I hurl it at them!\n[Area: Fireball — 20-ft sphere centred on G4; on my map it catches Bandit 1, Bandit 2]');
    // The template stays drawn until the message is sent or it is cleared.
    expect(app().querySelector('[data-map-layer="template"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear the area' }));
    expect(app().querySelector('[data-map-layer="template"]')).toBeNull();
  });

  it('nudges a centre with the buttons and the arrow keys', async () => {
    const user = renderArea();
    await pick(user, /Fireball/);
    await enterOn(6, 3);
    await user.click(screen.getByRole('button', { name: 'Nudge east' }));
    expect(readout()).toHaveTextContent('centred on H4');
    await act(async () => {
      fireEvent.keyDown(app(), { key: 'ArrowDown' });
    });
    expect(readout()).toHaveTextContent('centred on H5');
  });

  it('aims Burning Hands at a square and rotates it in 45° steps', async () => {
    const user = renderArea(heroTurnWithBanditAdjacent());
    await pick(user, /Burning Hands/);
    await enterOn(2, 4); // C5, where Bandit 1 stands
    expect(readout()).toHaveTextContent('Burning Hands · 15-ft cone toward C5 · catches Bandit 1');
    await user.click(screen.getByRole('button', { name: 'Add to message' }));
    expect(usePlayView.getState().draft).toBe('[Area: Burning Hands — 15-ft cone from Mira Voss toward C5; on my map it catches Bandit 1]');
    await user.click(screen.getByRole('button', { name: 'Rotate right' }));
    expect(readout()).toHaveTextContent('Burning Hands · 15-ft cone toward east ·');
    await act(async () => {
      fireEvent.keyDown(app(), { key: 'r', shiftKey: true });
    });
    expect(readout()).toHaveTextContent('toward north-east');
  });

  it('warns when you or an ally are inside, and when the centre is out of the spell’s range', async () => {
    const user = renderArea();
    await pick(user, /Shatter/);
    await enterOn(1, 4); // B5: Old Tam, next to you
    expect(screen.getByText('⚠ You are inside')).toBeInTheDocument();
    expect(screen.getByText('⚠ Old Tam is inside')).toBeInTheDocument();
    await enterOn(15, 11); // P12: 70 ft away
    expect(screen.getByText("⚠ Beyond Shatter's range (60 ft)")).toBeInTheDocument();
    expect(screen.queryByText('⚠ You are inside')).not.toBeInTheDocument();
  });

  it('makes a Custom area with a name, and a line with its width', async () => {
    const user = renderArea();
    await user.click(screen.getByRole('radio', { name: /Area/ }));
    const dialog = screen.getByRole('dialog', { name: 'Area of effect' });
    await user.click(within(dialog).getByRole('radio', { name: 'Line' }));
    await user.selectOptions(within(dialog).getByLabelText('Length'), '30');
    await user.selectOptions(within(dialog).getByLabelText('Width'), '10');
    await user.type(within(dialog).getByLabelText(/What is it\?/), 'Gust');
    await user.click(within(dialog).getByRole('button', { name: 'Place it' }));
    expect(readout()).toHaveTextContent(/^Gust · 30-ft line, 10 ft wide toward /);
  });

  it('shows only Custom while the rules index loads', async () => {
    mocks.index = null;
    const user = renderArea();
    await user.click(screen.getByRole('radio', { name: /Area/ }));
    const dialog = screen.getByRole('dialog', { name: 'Area of effect' });
    expect(within(dialog).queryByRole('region', { name: 'Your spells' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Place it' })).toBeInTheDocument();
  });
});
