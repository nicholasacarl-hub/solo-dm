import { describe, expect, it } from 'vitest';
import { portraitDisplay } from './portrait';

describe('portraitDisplay', () => {
  it('shows an emoji or a few characters as text', () => {
    expect(portraitDisplay('🧝')).toEqual({ kind: 'text', text: '🧝' });
    expect(portraitDisplay(' KB ')).toEqual({ kind: 'text', text: 'KB' });
  });

  it('shows images embedded in the save', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    expect(portraitDisplay(src)).toEqual({ kind: 'image', src });
  });

  it('refuses anything that would load from the network', () => {
    expect(portraitDisplay('https://tracker.example/p.png')).toBeNull();
    expect(portraitDisplay('http://127.0.0.1:9911/pixel.png')).toBeNull();
    expect(portraitDisplay('//tracker.example/p.png')).toBeNull();
    expect(portraitDisplay('blob:https://example.com/1')).toBeNull();
  });

  it('refuses empty and overlong values', () => {
    expect(portraitDisplay(undefined)).toBeNull();
    expect(portraitDisplay('   ')).toBeNull();
    expect(portraitDisplay('a portrait description that is far too long')).toBeNull();
  });
});
