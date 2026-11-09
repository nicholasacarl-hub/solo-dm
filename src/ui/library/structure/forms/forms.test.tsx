import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { EXPECTED_DATA, EXPECTED_MERGED, TEXT, gloamwoodEntries, gloamwoodRecords, type GloamwoodDataName } from '@/test/structuredFixtures';
import type { StructuredDataByKind, StructuredKind, StructuredRecord } from '@/types';
import { installDialogPolyfill } from '@/ui/shell/testUtils';
import { blocksFor } from '../bookData';
import { setViewport } from '../testing/bookPage';
import { RecordForm } from './RecordForm';

const entries = gloamwoodEntries();
const entriesById = new Map(entries.map((e) => [e.id, e]));
const records = gloamwoodRecords();
const recordOf = (name: string) => records.find((r) => r.name === name) as StructuredRecord;

function Harness<K extends StructuredKind>({
  kind,
  name,
  check = new Set<string>(),
  issues = {},
  onData,
  parentClassId,
}: {
  kind: K;
  name: GloamwoodDataName;
  check?: ReadonlySet<string>;
  issues?: Record<string, string>;
  onData?: (data: StructuredDataByKind[K]) => void;
  parentClassId?: string;
}) {
  const record = recordOf(name);
  const [value, setValue] = useState(EXPECTED_DATA[name] as StructuredDataByKind[K]);
  const [parent, setParent] = useState(parentClassId);
  return (
    <RecordForm
      kind={kind}
      value={value}
      onChange={(next) => {
        setValue(next);
        onData?.(next);
      }}
      check={check}
      issues={issues}
      blocks={blocksFor(record.entryIds, entriesById)}
      builder={EXPECTED_MERGED}
      disabled={false}
      name={record.name}
      onNameChange={() => {}}
      entriesById={entriesById}
      sourceId="gloam"
      bookRecords={records}
      parentClassId={parent}
      onParentClassChange={setParent}
      onFocusField={() => {}}
    />
  );
}

beforeEach(() => {
  installDialogPolyfill();
  setViewport(null);
});
afterEach(() => setViewport(null));

describe('each kind renders its key fields from the stored data and emits edits', () => {
  it('monster', async () => {
    const user = userEvent.setup();
    const onData = vi.fn();
    render(<Harness kind="monster" name="Glimmerwing Drake" onData={onData} />);
    expect(screen.getByLabelText('Size')).toHaveValue('Large');
    expect(screen.getByLabelText('Type')).toHaveValue('Dragon');
    expect(screen.getByLabelText('AC')).toHaveValue('17');
    expect(screen.getByLabelText('Note')).toHaveValue('natural armor');
    expect(screen.getByLabelText('HP')).toHaveValue('52');
    expect(screen.getByLabelText('Walk')).toHaveValue('30');
    expect(screen.getByLabelText('Fly')).toHaveValue('60');
    expect(screen.getByLabelText('Hover')).toBeChecked();
    expect(screen.getByLabelText('Initiative')).toHaveValue('+2');
    expect(screen.getByLabelText('Reach (ft)')).toHaveValue('10');
    expect(screen.getByLabelText('CR')).toHaveValue('3');
    expect(screen.getByLabelText('XP')).toHaveValue('700');
    await user.clear(screen.getByLabelText('HP'));
    await user.type(screen.getByLabelText('HP'), '58');
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ hp: 58 }));
    await user.click(screen.getByRole('button', { name: 'Raise Initiative' }));
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ initiative: 3 }));
  });

  it('spell', async () => {
    const user = userEvent.setup();
    const onData = vi.fn();
    render(<Harness kind="spell" name="Ashen Choir" onData={onData} />);
    expect(screen.getByLabelText('Level')).toHaveValue('2');
    expect(screen.getByLabelText('School')).toHaveValue('Evocation');
    expect(within(screen.getByRole('list', { name: 'Classes' })).getByText('Wickwright')).toBeInTheDocument();
    expect(screen.getByLabelText('Range')).toHaveValue('Self (15-foot cone)');
    expect(screen.getByLabelText('Shape')).toHaveValue('cone');
    expect(screen.getByLabelText('Length (ft)')).toHaveValue('15');
    expect(screen.getByLabelText('Saving throw')).toHaveValue('dex');
    await user.selectOptions(screen.getByLabelText('Shape'), 'line');
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ area: { shape: 'line', sizeFt: 15, widthFt: 5 } }));
  });

  it('magic item', () => {
    render(<Harness kind="magic-item" name="Mothsilk Cloak" />);
    expect(screen.getByLabelText('Category')).toHaveValue('wondrous-item');
    expect(screen.getByLabelText('Rarity')).toHaveValue('uncommon');
    expect(screen.getByRole('radio', { name: 'Required' })).toBeChecked();
    expect(screen.getByLabelText('AC')).toHaveValue('+1');
    expect(screen.getByLabelText('Saving throws')).toHaveValue('+1');
  });

  it('gear row', async () => {
    const user = userEvent.setup();
    const onData = vi.fn();
    render(<Harness kind="item" name="Hookstaff" onData={onData} />);
    expect(screen.getByRole('radio', { name: 'Weapon' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Martial' })).toBeChecked();
    expect(screen.getByLabelText('Damage dice')).toHaveValue('1d8');
    expect(within(screen.getByRole('list', { name: 'Properties' })).getByText('Two-Handed')).toBeInTheDocument();
    expect(screen.getByLabelText('Cost (GP)')).toHaveValue('12');
    await user.click(screen.getByRole('radio', { name: 'Simple' }));
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ weaponCategory: 'simple', description: 'Simple Melee Weapon' }));
  });

  it('feat', () => {
    render(<Harness kind="feat" name="Lantern Bearer" />);
    expect(screen.getByLabelText('Category')).toHaveValue('general');
    expect(screen.getByLabelText('Prerequisite')).toHaveValue('Level 4+');
    expect(screen.getByLabelText('Minimum level')).toHaveValue('4');
    expect(screen.getByRole('button', { name: 'Wisdom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Strength' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Text: paragraphs 2 to 4 of Lantern Bearer' })).toBeInTheDocument();
  });

  it('background', () => {
    render(<Harness kind="background" name="Lamplighter" />);
    for (const a of ['Dexterity', 'Wisdom', 'Charisma']) expect(screen.getByRole('button', { name: a })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Origin feat')).toHaveValue("Moth's Grace");
    expect(screen.getByRole('button', { name: 'Perception' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Tool proficiency')).toHaveValue("Tinker's Tools");
    expect(screen.getByLabelText('Option A: item 2')).toHaveValue('Hookstaff');
  });

  it('species', () => {
    render(<Harness kind="species" name="Mothkin" />);
    expect(screen.getByLabelText('Creature type')).toHaveValue('Humanoid');
    expect(screen.getByRole('button', { name: 'Small' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Speed (ft)')).toHaveValue('30');
    expect(screen.getByLabelText('Darkvision (ft)')).toHaveValue('60');
    expect(screen.getAllByLabelText(/^Name/).map((i) => (i as HTMLInputElement).value)).toEqual(
      expect.arrayContaining(['Dusk Sight', 'Powdered Wings', 'Lamp-Drawn', 'Ashwing', 'Silverwing']),
    );
    expect(screen.getByLabelText('Trait that offers the lineages')).toHaveValue('Lamp-Drawn');
  });

  it('class', () => {
    render(<Harness kind="class" name="Wickwright" />);
    expect(screen.getByLabelText('Hit die')).toHaveValue('8');
    expect(screen.getByLabelText('Subclass at level')).toHaveValue('3');
    const saves = screen.getByRole('group', { name: 'Saving throws (2)' });
    expect(within(saves).getByRole('button', { name: 'Intelligence' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(saves).getByRole('button', { name: 'Wisdom' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Spellcasting')).toHaveValue('half');
    expect(screen.getByLabelText('Level 3, Prepared spells')).toHaveValue('4');
  });

  it('subclass: "Attaches to" groups the classes and pre-selects the stored parent', () => {
    render(<Harness kind="subclass" name="Ember Warden" parentClassId="srd:class:fighter" />);
    const select = screen.getByLabelText('Attaches to');
    expect(select).toHaveValue('srd:class:fighter');
    const groups = within(select).getAllByRole('group').map((g) => g.getAttribute('label'));
    expect(groups).toEqual(expect.arrayContaining(['SRD', 'This book']));
    expect(within(select).getByRole('option', { name: 'Wickwright' })).toBeInTheDocument();
    expect(screen.getByText(/The book says “Fighter”\. Matched the SRD Fighter\./)).toBeInTheDocument();
  });
});

describe('checks and problems', () => {
  it('"Check" is part of the field label\'s accessible name', () => {
    render(<Harness kind="monster" name="Glimmerwing Drake" check={new Set(['hp', 'hitDice'])} />);
    expect(screen.getByRole('textbox', { name: 'HP Check' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'AC' })).toBeInTheDocument();
  });

  it('a schema problem is tied to its field', () => {
    render(<Harness kind="monster" name="Glimmerwing Drake" issues={{ ac: 'At most 40.' }} />);
    const ac = screen.getByLabelText('AC');
    expect(ac).toHaveAccessibleDescription('At most 40.');
    expect(ac).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('text spans', () => {
  it('the chip shows the exact words that will be attached', async () => {
    const user = userEvent.setup();
    render(<Harness kind="feat" name="Lantern Bearer" />);
    await user.click(screen.getByRole('button', { name: 'Text: paragraphs 2 to 4 of Lantern Bearer' }));
    expect(screen.getByText(/The words that will be attached/)).toBeInTheDocument();
    expect(screen.getByText(/Increase your Wisdom or Charisma score by 1/)).toBeInTheDocument();
    expect(TEXT.lanternBearer[0]).toBe('You gain the following benefits.');
  });

  it('a span past the end of its block is red with the reason', () => {
    function Bad() {
      const record = recordOf("Moth's Grace");
      const data = { ...(EXPECTED_DATA["Moth's Grace"] as StructuredDataByKind['feat']) };
      data.text = { ...data.text, from: 7, to: 9 };
      return (
        <RecordForm
          kind="feat"
          value={data}
          onChange={() => {}}
          check={new Set()}
          issues={{}}
          blocks={blocksFor(record.entryIds, entriesById)}
          builder={EXPECTED_MERGED}
          disabled={false}
          name={record.name}
          onNameChange={() => {}}
          entriesById={entriesById}
          sourceId="gloam"
          bookRecords={records}
          onParentClassChange={() => {}}
          onFocusField={() => {}}
        />
      );
    }
    render(<Bad />);
    expect(screen.getByText(/Paragraph 9 doesn't exist: ‘Moth's Grace’ has \d+\./)).toBeInTheDocument();
  });

  it('"Change…" picks the start and the end from radio groups', async () => {
    const user = userEvent.setup();
    const onData = vi.fn();
    render(<Harness kind="feat" name="Lantern Bearer" onData={onData} />);
    await user.click(screen.getByRole('button', { name: 'Change…' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose the text' });
    const starts = within(dialog).getByRole('group', { name: 'Starts at' });
    const ends = within(dialog).getByRole('group', { name: 'Ends at' });
    expect(within(starts).getAllByRole('radio')[1]).toBeChecked();
    await user.click(within(starts).getAllByRole('radio')[2]);
    await user.click(within(ends).getAllByRole('radio')[2]);
    await user.click(within(dialog).getByRole('button', { name: 'Use ¶3' }));
    expect(onData).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.objectContaining({ from: 3, to: 3 }) }));
  });
});

describe('rows of features and traits', () => {
  it('U15: each row\'s controls have names of their own (not "Name" and "Change…" over and over)', () => {
    render(<Harness kind="class" name="Wickwright" />);
    expect(screen.getByRole('textbox', { name: 'Name of feature 2 (level 1)' })).toHaveValue('Wick Sense');
    expect(screen.getByRole('textbox', { name: 'Name of feature 4 (level 4)' })).toHaveValue('Ability Score Improvement');
    expect(screen.getByRole('button', { name: 'Change the text of Wick Sense' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change the text of Spellcasting' })).toBeInTheDocument();
  });

  it('U15: the phone level table\'s "Columns" toggle is a 44 px target', () => {
    setViewport(390);
    render(<Harness kind="class" name="Wickwright" />);
    const summary = screen.getByText('Columns', { selector: 'summary' });
    expect(summary).toHaveClass('max-sm:min-h-11', 'pointer-coarse:min-h-11');
  });
});

describe('the level table', () => {
  it('labels every cell by level and column, and renames a column', async () => {
    const user = userEvent.setup();
    const onData = vi.fn();
    render(<Harness kind="class" name="Wickwright" onData={onData} />);
    expect(screen.getByLabelText('Level 1, Wicks')).toHaveValue('2');
    expect(screen.getByLabelText('Level 20, Slot 5')).toHaveValue('2');
    await user.clear(screen.getByLabelText('Level 3, Prepared spells'));
    await user.type(screen.getByLabelText('Level 3, Prepared spells'), '5');
    const table = onData.mock.lastCall?.[0].levelTable as Record<string, unknown>[];
    expect(table[2].preparedSpells).toBe(5);
  });

  it('steps through levels on a phone', async () => {
    setViewport(390);
    const user = userEvent.setup();
    render(<Harness kind="class" name="Wickwright" />);
    expect(screen.getByLabelText('Level 1, Prepared spells')).toHaveValue('2');
    await user.click(screen.getByRole('button', { name: 'Next level' }));
    await user.click(screen.getByRole('button', { name: 'Next level' }));
    expect(screen.getByLabelText('Level 3, Prepared spells')).toHaveValue('4');
    expect(screen.getByLabelText('Level')).toHaveValue('3');
  });
});
