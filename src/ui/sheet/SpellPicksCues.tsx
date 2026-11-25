/**
 * Where the sheet says spell choices are open: a banner per class on the Spells tab ("Wizard 4: choose 1 cantrip, 6
 * spellbook spells and 2 prepared spells", opening the choices form), "Change prepared spells" (or, for the Wizard,
 * "Replace a cantrip") for a class whose rules allow a change after a Long Rest, a one-line note in the sheet's header
 * and a badge on the Spells tab. Each reads the class data (useBuilderData), so the sheet mounts the note and the badge
 * only while Spellcasting.spellPicks has entries: a sheet without them loads nothing new. What they show is live
 * (openSpellPicks): spells the DM recorded meanwhile settle them.
 */
import { Sparkles } from 'lucide-react';
import { useBuilderData } from '@/data';
import { openSpellPicks, type OpenSpellPicks } from '@/data/options/spellPicks';
import { classOptionFor } from '@/data/options/resolve';
import type { Character, ClassLevel } from '@/types';
import { Button } from '@/ui/components/ui';
import type { SpellPicksTarget } from './SpellPicksForm';
import { openPicksText, picksNoteText, restButtonText, restChangeKind } from './spellPicksText';

/** The classes whose choices are open now (none until the class data loads). */
function useOpenPicks(c: Character): OpenSpellPicks[] {
  const { data } = useBuilderData();
  return data ? openSpellPicks(c, data.classes) : [];
}

/** Whether the sheet should mount the note and the badge: the mark that a level's choices were left open. */
export function hasSpellPicks(c: Character): boolean {
  return Boolean(c.spellcasting?.spellPicks?.length);
}

/** The sheet header's line, as TransformedNote's: "Spells to choose: Wizard 4", opening the first class's choices. */
export function SpellPicksNote({ character, onOpen }: { character: Character; onOpen: (target: SpellPicksTarget) => void }) {
  const open = useOpenPicks(character);
  if (!open.length) return null;
  const text = picksNoteText(open);
  return (
    <button
      type="button"
      onClick={() => onOpen({ mode: 'level', classId: open[0].cl.classId })}
      title="Choose spells"
      className="mt-1 flex max-w-full min-w-0 items-center gap-1 rounded-md text-left text-xs font-medium text-arcane hover:underline pointer-coarse:min-h-11"
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </button>
  );
}

/** The Spells tab's badge while choices are open. */
export function SpellPicksBadge({ character }: { character: Character }) {
  const open = useOpenPicks(character);
  if (!open.length) return null;
  return (
    <>
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-arcane" />
      <span className="sr-only">(spells to choose)</span>
    </>
  );
}

/** The classes with a change after a Long Rest that the form makes (a Wizard's prepared spells change with the checkboxes). */
function restChanges(c: Character, classes: Parameters<typeof classOptionFor>[1]): { cl: ClassLevel; kind: 'spells' | 'cantrip' }[] {
  return c.classes.flatMap((cl) => {
    const cls = classOptionFor(cl, classes);
    const kind = cls ? restChangeKind(cls) : null;
    return kind ? [{ cl, kind }] : [];
  });
}

function Unavailable({ children }: { children: string }) {
  return <p className="rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-muted">{children}</p>;
}

/**
 * The Spells tab's top: a banner per class with open choices, and "Change prepared spells" ("Replace a cantrip" for a
 * Wizard, whose Long Rest change in the form is only that) where a Long Rest allows. A class marked open whose details
 * aren't on this device (a book that isn't here, data that couldn't load) says so: the choices stay open, and the DM can
 * add the spells.
 */
export function SpellChoicesBar({ character, onOpen }: { character: Character; onOpen: (target: SpellPicksTarget) => void }) {
  const { data, error } = useBuilderData();
  const marked = (character.spellcasting?.spellPicks ?? []).flatMap((p) => character.classes.filter((cl) => cl.classId === p.classId));
  if (!data) {
    return error && marked.length ? <Unavailable>{`Your spell choices are open, but class details couldn't load (${error}). Your DM can add spells.`}</Unavailable> : null;
  }
  const open = openSpellPicks(character, data.classes);
  const missing = marked.filter((cl) => !classOptionFor(cl, data.classes));
  const rest = restChanges(character, data.classes);
  if (!open.length && !missing.length && !rest.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {missing.map((cl) => (
        <Unavailable key={cl.classId}>{`${cl.name} ${cl.level}: its spell choices are open, but its details aren't on this device. Your DM can add spells.`}</Unavailable>
      ))}
      {open.map((p) => (
        <div key={p.cl.classId} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-arcane/40 bg-arcane-soft px-3 py-2">
          <Sparkles className="size-4 shrink-0 text-arcane" aria-hidden />
          <p className="min-w-0 flex-1 basis-48 text-sm">{openPicksText(p)}</p>
          <Button size="sm" variant="arcane" onClick={() => onOpen({ mode: 'level', classId: p.cl.classId })} aria-label={`Choose spells for ${p.cl.name} ${p.cl.level}`} className="pointer-coarse:min-h-11">
            Choose spells
          </Button>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {rest.map(({ cl, kind }) => (
            <Button key={cl.classId} size="sm" variant="ghost" onClick={() => onOpen({ mode: 'rest', classId: cl.classId })} className="pointer-coarse:min-h-11">
              {restButtonText(kind, cl.name, rest.length > 1)}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
