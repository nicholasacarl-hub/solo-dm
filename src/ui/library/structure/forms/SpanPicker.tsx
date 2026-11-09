/**
 * Choose which paragraphs a feature's text is: a block of the record (its entries, in reading order)
 * and two radio groups, "Starts at" and "Ends at" (spec §4.5).
 */
import { useId, useState } from 'react';
import type { CandidateBlock } from '@/data';
import type { CompendiumEntry, TextSpan } from '@/types';
import { Button, Dialog, Field, Select } from '@/ui/components/ui';
import { blockForSpan } from '../bookData';
import { plainParagraph } from '../excerpts';

const preview = (p: string) => {
  const plain = plainParagraph(p);
  return plain.length > 90 ? `${plain.slice(0, 88)}…` : plain;
};

export function SpanPicker({
  open,
  span,
  blocks,
  entriesById,
  onPick,
  onClose,
}: {
  open: boolean;
  span: TextSpan;
  blocks: readonly CandidateBlock[];
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  onPick(next: TextSpan): void;
  onClose(): void;
}) {
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Choose the text" description="Pick the paragraphs the app attaches to this feature.">
      {open && <PickerBody span={span} blocks={blocks} entriesById={entriesById} onPick={onPick} onClose={onClose} />}
    </Dialog>
  );
}

function PickerBody({
  span,
  blocks,
  entriesById,
  onPick,
  onClose,
}: {
  span: TextSpan;
  blocks: readonly CandidateBlock[];
  entriesById: ReadonlyMap<string, CompendiumEntry>;
  onPick(next: TextSpan): void;
  onClose(): void;
}) {
  const id = useId();
  const current = blockForSpan(span.entryIds, blocks, entriesById);
  const choices = current && !blocks.includes(current) ? [current, ...blocks] : blocks;
  const [blockKey, setBlockKey] = useState(() => (current ?? choices[0])?.entryIds.join(' ') ?? '');
  const block = choices.find((b) => b.entryIds.join(' ') === blockKey) ?? choices[0];
  const count = block?.paragraphs.length ?? 0;
  const clamp = (n: number) => Math.min(Math.max(1, n), Math.max(1, count));
  const [from, setFrom] = useState(() => clamp(span.from));
  const [to, setTo] = useState(() => clamp(Math.max(span.to, span.from)));

  if (!block) return <p className="text-sm text-muted">This record has no text to choose from.</p>;

  const choose = (which: 'from' | 'to', n: number) => {
    if (which === 'from') {
      setFrom(n);
      if (to < n) setTo(n);
    } else {
      setTo(n);
      if (from > n) setFrom(n);
    }
  };

  const radios = (which: 'from' | 'to', legend: string, value: number) => (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1 scroll-thin">
        {block.paragraphs.map((p, i) => (
          <li key={i}>
            <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
              <input
                type="radio"
                name={`${id}-${which}`}
                checked={value === i + 1}
                onChange={() => choose(which, i + 1)}
                className="mt-1 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="mr-1.5 font-medium tabular-nums">¶{i + 1}</span>
                <span className="text-muted">{preview(p)}</span>
              </span>
            </label>
          </li>
        ))}
      </ol>
    </fieldset>
  );

  return (
    <div className="flex flex-col gap-4">
      <Field label="Where" htmlFor={`${id}-block`}>
        <Select
          id={`${id}-block`}
          value={blockKey}
          onChange={(e) => {
            setBlockKey(e.target.value);
            setFrom(1);
            setTo(1);
          }}
        >
          {choices.map((b) => (
            <option key={b.entryIds.join(' ')} value={b.entryIds.join(' ')}>
              {b.title} ({b.paragraphs.length} {b.paragraphs.length === 1 ? 'paragraph' : 'paragraphs'})
            </option>
          ))}
        </Select>
      </Field>
      {count === 0 ? (
        <p className="text-sm text-muted">This entry's paragraphs couldn't be read.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {radios('from', 'Starts at', from)}
          {radios('to', 'Ends at', to)}
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={count === 0} onClick={() => onPick({ entryIds: [...block.entryIds], from, to })}>
          Use ¶{from === to ? from : `${from}–${to}`}
        </Button>
      </div>
    </div>
  );
}
