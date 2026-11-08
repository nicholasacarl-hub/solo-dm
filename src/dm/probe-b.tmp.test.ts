import { it } from 'vitest';
import { sampleCharacter, sampleMappedCombat, sampleStopCombat } from '@/test/fixtures';
import { mapGlyphGrid, mapSnapshot, mapWarnings, planMove, placeCombatants, playerView, reachableSquares, turnBudget } from '@/engine';

it('probe', () => {
  const hero = sampleCharacter();
  const s = sampleMappedCombat({ heroTurn: true });
  const snap = mapSnapshot(s, hero, { perspective: 'dm' });
  console.log(JSON.stringify(snap, null, 1).slice(0, 6000));
  console.log(mapGlyphGrid(s, hero).rows.join('\n'));
  console.log(JSON.stringify(mapGlyphGrid(s, hero).legend));
  const stop = sampleStopCombat();
  console.log(JSON.stringify(mapSnapshot(stop, hero, { perspective: 'dm' })?.reach));
  console.log(JSON.stringify(mapSnapshot(stop, hero, { perspective: 'dm' })?.tokens.map((t) => [t.name, t.enemiesWithin5, t.reactionUsed])));
  const b = sampleMappedCombat();
  const p = planMove(b, hero, { moverId: 'c-2', kind: 'move', by: 'dm', to: { kind: 'creature', id: 'c-1' } });
  console.log(JSON.stringify(p));
  console.log(JSON.stringify(turnBudget(b, hero, 'c-3')));
  console.log(JSON.stringify(mapWarnings(b, hero)));
  console.log(JSON.stringify(reachableSquares(b, hero, 'c-2').length));
  console.log(JSON.stringify(playerView(b).combatants.map((c) => c.name)));
  void placeCombatants;
});
