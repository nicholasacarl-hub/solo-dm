import { describe, expect, it } from 'vitest';
import { bookFingerprint, importedPlaceholder, isImportedPlaceholder, redactImported, textFingerprint, wrapImported } from './importedContent';

describe('textFingerprint', () => {
  it('is FNV-1a 64 (standard test vectors), as 16 hex chars', () => {
    expect(textFingerprint('')).toBe('cbf29ce484222325');
    expect(textFingerprint('a')).toBe('af63dc4c8601ec8c');
    expect(textFingerprint('foobar')).toBe('85944171f73967e8');
  });

  it('ignores NFKC differences and whitespace runs, not words', () => {
    expect(textFingerprint('  You  gain\n\nthe ﬁre ')).toBe(textFingerprint('You gain the fire'));
    expect(textFingerprint('You gain the fire')).not.toBe(textFingerprint('You gain the fires'));
    expect(textFingerprint('Moth’s Grace')).not.toBe(textFingerprint("Moth's Grace"));
  });

  it('fingerprints a book by its entries in order', () => {
    expect(bookFingerprint(['a', 'b'])).toBe(textFingerprint('a\n\u0000\nb'));
    expect(bookFingerprint(['a', 'b'])).not.toBe(bookFingerprint(['b', 'a']));
  });
});

describe('importedPlaceholder', () => {
  it('is exactly the sentence redactImported leaves', () => {
    expect(redactImported(wrapImported('The "Gloam" <Book>', 'secret text'))).toBe(importedPlaceholder('The "Gloam" <Book>'));
    expect(isImportedPlaceholder(importedPlaceholder('Any Book'))).toBe(true);
    expect(isImportedPlaceholder(` ${importedPlaceholder('Any Book')}\n`)).toBe(true);
    expect(isImportedPlaceholder('You gain a bonus.')).toBe(false);
    expect(isImportedPlaceholder(undefined)).toBe(false);
  });
});
