/**
 * Notes tab: personality, appearance, backstory and the player's own notes.
 * Edits save when the field loses focus.
 */
import { useEffect, useId, useState } from 'react';
import type { Character, Personality } from '@/types';
import { Markdown } from '@/ui/components/Markdown';
import { Textarea } from '@/ui/components/ui';
import { PERSONALITY_LABELS, dmSheetLengthHint, notesChange, personalityChange } from './sheetChanges';
import { SheetSection } from './SheetParts';
import type { SheetChange } from './useSheetActions';

const FIELDS: (keyof Personality)[] = ['traits', 'ideals', 'bonds', 'flaws', 'appearance', 'backstory'];

function EditableText({
  label,
  value,
  placeholder,
  rows = 2,
  onSave,
}: {
  label: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onSave: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const id = useId();
  const hintId = useId();
  const hint = dmSheetLengthHint(draft);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      <Textarea
        id={id}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onSave(draft);
        }}
        aria-describedby={hint ? hintId : undefined}
        className="min-h-0 text-sm"
      />
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function NotesPanel({
  character: c,
  editable,
  onEdit,
}: {
  character: Character;
  editable: boolean;
  onEdit: (change: (c: Character) => SheetChange) => void;
}) {
  if (!editable) {
    const filled = FIELDS.filter((f) => c.personality[f]);
    return (
      <div className="flex flex-col gap-3">
        {filled.map((f) => (
          <SheetSection key={f} title={PERSONALITY_LABELS[f]}>
            <Markdown className="text-sm">{c.personality[f] ?? ''}</Markdown>
          </SheetSection>
        ))}
        {c.notes && (
          <SheetSection title="Notes">
            <Markdown className="text-sm">{c.notes}</Markdown>
          </SheetSection>
        )}
        {!filled.length && !c.notes && <p className="text-sm text-muted">No personality or notes yet.</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <SheetSection title="Personality">
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2">
          {FIELDS.filter((f) => f !== 'backstory').map((f) => (
            <EditableText
              key={f}
              label={PERSONALITY_LABELS[f]}
              value={c.personality[f] ?? ''}
              onSave={(text) => onEdit((cur) => personalityChange(cur, f, text))}
            />
          ))}
        </div>
      </SheetSection>
      <EditableText
        label="Backstory"
        rows={5}
        value={c.personality.backstory ?? ''}
        onSave={(text) => onEdit((cur) => personalityChange(cur, 'backstory', text))}
      />
      <EditableText
        label="Notes"
        rows={6}
        value={c.notes}
        placeholder="Names, clues, plans…"
        onSave={(text) => onEdit((cur) => notesChange(cur, text))}
      />
    </div>
  );
}
