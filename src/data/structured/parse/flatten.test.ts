import { describe, expect, it } from 'vitest';
import { flatten } from './flatten';

describe('flatten (the flattened-PDF dialect)', () => {
  it('drops emphasis and list markers, keeps headings (at most level 3) and one paragraph per line', () => {
    expect(flatten('## Name\n\n_**Bold.**_ text\nwrapped line\n\n- **AC** 15\n- **HP** 10\n\n#### Deep')).toBe(
      '## Name\n\nBold. text wrapped line\n\nAC 15\n\nHP 10\n\n### Deep',
    );
  });

  it('turns tables into loose rows (header and separator dropped, cells joined by spaces)', () => {
    expect(flatten('| Lineage | Level 1 |\n|---|---|\n| Ashwing | Light |\n| Silverwing | — |')).toBe('Ashwing Light\n\nSilverwing —');
  });
});
