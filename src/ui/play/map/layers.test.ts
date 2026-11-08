import { describe, expect, it } from 'vitest';
import { CELL } from './camera';
import { tweenRoute } from './layers';

const px = (x: number, y: number) => ({ x: x * CELL, y: y * CELL });

describe('tweenRoute: how a token travels to its new square', () => {
  // B6 → B9 (along B7, B8), then B9 → C9.
  const first = { from: { x: 1, y: 5 }, path: [{ x: 1, y: 6 }, { x: 1, y: 7 }, { x: 1, y: 8 }] };
  const second = { from: { x: 1, y: 8 }, path: [{ x: 2, y: 8 }] };

  it('follows the move it arrived by', () => {
    expect(tweenRoute(px(1, 5), px(1, 8), first)).toEqual([px(1, 5), px(1, 6), px(1, 7), px(1, 8)]);
    expect(tweenRoute(px(1, 8), px(2, 8), second)).toEqual([px(1, 8), px(2, 8)]);
  });

  it('U14: undoing the second of two moves slides straight back, not along the first move’s route', () => {
    // After the Undo the hero stands at B9, the end of the first move, but it is drawn coming from C9.
    expect(tweenRoute(px(2, 8), px(1, 8), first)).toEqual([px(2, 8), px(1, 8)]);
  });

  it('goes straight without a move, or when the move ends elsewhere (the DM moved the hero on)', () => {
    expect(tweenRoute(px(1, 5), px(3, 5), null)).toEqual([px(1, 5), px(3, 5)]);
    expect(tweenRoute(px(1, 8), px(0, 6), first)).toEqual([px(1, 8), px(0, 6)]);
  });
});
