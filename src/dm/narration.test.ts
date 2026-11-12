import { describe, expect, it } from 'vitest';
import { isOoc, parseChoices, parseWrapUp, playerTextForModel, truncate, visibleWhileStreaming } from './narration';

describe('parseChoices', () => {
  it('strips a trailing choices block and returns its lines', () => {
    expect(parseChoices('The gate looms.\n\n```choices\nSlip past the guards\nBluff your way in\nWait for nightfall\n```')).toEqual({
      text: 'The gate looms.',
      choices: ['Slip past the guards', 'Bluff your way in', 'Wait for nightfall'],
    });
  });

  it('cleans bullets and numbering, drops blank lines, and keeps at most four', () => {
    const parsed = parseChoices('Go.\n```choices\n- One\n\n2. Two\n* **Three**\nFour\nFive\n```');
    expect(parsed.choices).toEqual(['One', 'Two', 'Three', 'Four']);
  });

  it('handles an unterminated block and text without one', () => {
    expect(parseChoices('Run!\n```choices\nLeft\nRight')).toEqual({ text: 'Run!', choices: ['Left', 'Right'] });
    expect(parseChoices('Just narration.')).toEqual({ text: 'Just narration.' });
    expect(parseChoices('Empty.\n```choices\n```')).toEqual({ text: 'Empty.' });
  });

  it('hides a choices block that is still streaming', () => {
    expect(visibleWhileStreaming('The door opens.\n\n```choi')).toBe('The door opens.');
    expect(visibleWhileStreaming('The door opens.\n\n```choices\nEnter')).toBe('The door opens.');
    expect(visibleWhileStreaming('The door opens.\n\n`')).toBe('The door opens.');
    expect(visibleWhileStreaming('Plain text so far')).toBe('Plain text so far');
  });
});

describe('OOC', () => {
  it('wraps out-of-character messages for the model', () => {
    expect(isOoc('OOC: how does grappling work?')).toBe(true);
    expect(isOoc('ooc:wait')).toBe(true);
    expect(isOoc('(OOC) quick question')).toBe(true);
    expect(isOoc('I look at the cook.')).toBe(false);
    expect(playerTextForModel('  OOC: how does grappling work?  ')).toBe('<ooc>how does grappling work?</ooc>');
    expect(playerTextForModel('I draw my sword.')).toBe('I draw my sword.');
  });
});

describe('parseWrapUp', () => {
  it('splits the recap from the private DM notes', () => {
    expect(parseWrapUp('## Recap\nYou won.\n\n## DM Notes\nThe king lied.')).toEqual({ recap: 'You won.', dmNotes: 'The king lied.' });
  });

  it('accepts other heading styles and ignores preamble', () => {
    expect(parseWrapUp('Saving notes first.\n\n# Recap\nYou fled.\n\n**DM Notes**\nThe tower is a trap.')).toEqual({
      recap: 'You fled.',
      dmNotes: 'The tower is a trap.',
    });
  });

  it('falls back to the whole text as the recap', () => {
    expect(parseWrapUp('You survived the night.')).toEqual({ recap: 'You survived the night.', dmNotes: null });
  });
});

describe('truncate', () => {
  it('shortens on a word boundary with an ellipsis', () => {
    expect(truncate('The quick brown fox jumps over the lazy dog', 20)).toBe('The quick brown fox…');
    expect(truncate('short', 20)).toBe('short');
  });

  it('never cuts between the halves of an emoji', () => {
    const cut = truncate('🐉'.repeat(40), 20);
    expect(cut).toBe(`${'🐉'.repeat(9)}…`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
