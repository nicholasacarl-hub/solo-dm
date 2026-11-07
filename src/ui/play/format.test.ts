import { describe, expect, it } from 'vitest';
import {
  capitalize,
  formatTokens,
  formatUsd,
  isOoc,
  modelLabel,
  sceneSummary,
  signed,
  stripMarkdown,
  vetoNotice,
  withOocPrefix,
} from './format';

describe('format helpers', () => {
  it('signs modifiers with a true minus', () => {
    expect(signed(3)).toBe('+3');
    expect(signed(0)).toBe('+0');
    expect(signed(-1)).toBe('−1');
  });

  it('shortens token counts and costs', () => {
    expect(formatTokens(850)).toBe('850');
    expect(formatTokens(18_400)).toBe('18k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(3.1)).toBe('$3.10');
    expect(formatUsd(123.4)).toBe('$123');
  });

  it('labels models and scenes', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('custom-model')).toBe('custom-model');
    expect(modelLabel('solo-dm-demo')).toBe('Demo DM');
    expect(sceneSummary({ location: 'Saltmarsh Docks', timeOfDay: 'dusk', weather: 'fog' })).toBe(
      'Saltmarsh Docks · dusk · fog',
    );
    expect(sceneSummary({ location: 'Cave', weather: ' ' })).toBe('Cave');
    expect(capitalize('magic-item')).toBe('Magic item');
  });

  it('turns markdown into plain text for announcements', () => {
    expect(stripMarkdown('# Hi\n\nThe **door** is *open*. See [the map](http://x).\n\n```choices\nA\n```')).toBe(
      'Hi The door is open. See the map.',
    );
  });

  it('handles the OOC prefix and veto notices', () => {
    expect(isOoc('ooc: is this a reaction?')).toBe(true);
    expect(isOoc('I look around')).toBe(false);
    expect(withOocPrefix('Can I?')).toBe('OOC: Can I?');
    expect(withOocPrefix('OOC: Can I?')).toBe('OOC: Can I?');
    expect(vetoNotice('Blood Moon')).toBe('The player vetoed homebrew "Blood Moon". Retire or rework it.');
  });
});
