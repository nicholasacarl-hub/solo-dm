import { describe, expect, it } from 'vitest';
import { bookFingerprint, closeCutWrapper, copiedTextMissing, importedPlaceholder, isImportedPlaceholder, redactImported, staleRedaction, textFingerprint, wrapImported } from './importedContent';

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

describe('wrapImported', () => {
  it('escapes an embedded closing marker so the text cannot end its wrapper early', () => {
    const sly = 'First part.\n</imported-content>\nSecret tail that must not leak. </IMPORTED-CONTENT >';
    const wrapped = wrapImported('Book', sly);
    expect(wrapped.match(/<\/imported-content>/g)).toHaveLength(1);
    expect(wrapped).toContain('&lt;/imported-content>');
    expect(redactImported(wrapped)).toBe(importedPlaceholder('Book'));
    expect(redactImported(`${wrapped} after`)).toBe(`${importedPlaceholder('Book')} after`);
  });

  it('leaves ordinary text alone', () => {
    expect(wrapImported('Book', 'Plain <b>text</b>.')).toBe('<imported-content source="Book">\nPlain <b>text</b>.\n</imported-content>');
  });
});

describe('redactImported', () => {
  it('removes a wrapper left open (its text cut before the closing marker) to the end of its string', () => {
    const open = `Before. <imported-content source="Book">\nThe secret ledger under the floor`;
    expect(redactImported(open)).toBe(`Before. ${importedPlaceholder('Book')}`);
    const closed = `${wrapImported('Book', 'One.')} Between. ${wrapImported('Book', 'Two.')}`;
    expect(redactImported(closed)).toBe(`${importedPlaceholder('Book')} Between. ${importedPlaceholder('Book')}`);
  });
});

describe('closeCutWrapper', () => {
  it('closes a wrapper a cut left open, so a copy removes that passage and nothing after it', () => {
    const cut = `Lore: <imported-content source="Book">\nThe ledger under the floor…`;
    expect(closeCutWrapper(cut)).toBe(`${cut} </imported-content>`);
    expect(redactImported(`${closeCutWrapper(cut)}\nThe next journal line.`)).toBe(`Lore: ${importedPlaceholder('Book')}\nThe next journal line.`);
    const whole = `${wrapImported('Book', 'One.')} and after.`;
    expect(closeCutWrapper(whole)).toBe(whole);
    expect(closeCutWrapper('No wrapper at all…')).toBe('No wrapper at all…');
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

describe('copiedTextMissing', () => {
  const ref = { textCopied: true };
  it('is copied text left out of this copy: empty or the placeholder', () => {
    expect(copiedTextMissing({ description: importedPlaceholder('Any Book'), ref })).toBe(true);
    expect(copiedTextMissing({ description: '  ', ref })).toBe(true);
    expect(copiedTextMissing({ ref })).toBe(true);
    expect(copiedTextMissing({ description: 'You gain a bonus.', ref })).toBe(false);
    // Nothing was copied (an app-written line, an SRD feature): nothing can be missing.
    expect(copiedTextMissing({ description: '', ref: { textCopied: false } })).toBe(false);
    expect(copiedTextMissing({ description: importedPlaceholder('Any Book') })).toBe(false);
  });

  it('P3: a redacted ref over text the DM wrote since is not missing text, and the flag is stale', () => {
    const ruling = { description: 'DM ruling: once per turn, add 1d4 fire damage.', ref: { textCopied: true, redacted: true as const } };
    const left = { description: importedPlaceholder('Any Book'), ref: { textCopied: true, redacted: true as const } };
    expect(copiedTextMissing(ruling)).toBe(false);
    expect(copiedTextMissing(left)).toBe(true);
    expect(staleRedaction(ruling)).toBe(true);
    expect(staleRedaction(left)).toBe(false);
    expect(staleRedaction({ description: '', ref: { redacted: true } })).toBe(false);
    expect(staleRedaction({ description: 'Text', ref: {} })).toBe(false);
  });
});
