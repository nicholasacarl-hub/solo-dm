import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Button, Dialog, Input, Select, Textarea } from './ui';

/**
 * What Chromium does on a second Escape (or Android Back) with no user activation in between: the
 * `cancel` it fires can't be cancelled, then the dialog closes no matter what the page wanted.
 */
function forceNativeClose(dialog: HTMLElement): void {
  fireEvent(dialog, new Event('cancel', { cancelable: false }));
  if (dialog.hasAttribute('open')) {
    dialog.removeAttribute('open');
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent(dialog, new Event('close'));
  }
}

describe('Dialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is named by its title and described by its description', () => {
    render(
      <Dialog open onClose={() => {}} dismissible={false} title="Perception check (WIS)" description="Spot the ambush.">
        <Button>Roll</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Perception check (WIS)' });
    expect(dialog).toHaveAccessibleDescription('Spot the ambush.');
  });

  it('keeps a locked dialog open on Escape', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} dismissible={false} title="Roll">
        <Button>Roll</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Roll' });
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(dialog).toHaveAttribute('open');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a locked dialog again when the browser closes it anyway, with focus back on its control', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} dismissible={false} title="Perception check (WIS)">
        <Button>Cancel turn</Button>
        <Button>Roll</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Perception check (WIS)' });
    const roll = screen.getByRole('button', { name: 'Roll' });
    roll.focus();

    forceNativeClose(dialog);
    expect(dialog).toHaveAttribute('open');
    expect(roll).toHaveFocus();

    forceNativeClose(dialog);
    expect(dialog).toHaveAttribute('open');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a forced close once, and stays up when the owner refuses (busy)', () => {
    const onClose = vi.fn();
    function BusyImport() {
      const [open] = useState(true);
      return (
        <Dialog open={open} onClose={onClose} title="Import into your library">
          <p>Importing…</p>
        </Dialog>
      );
    }
    render(<BusyImport />);
    const dialog = screen.getByRole('dialog', { name: 'Import into your library' });

    forceNativeClose(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveAttribute('open');
  });

  it('closes for good when the owner accepts a forced close', () => {
    const onClose = vi.fn();
    function Notes() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog
          open={open}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          title="Notes"
        />
      );
    }
    render(<Notes />);
    const dialog = screen.getByRole('dialog', { name: 'Notes' });

    forceNativeClose(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveAttribute('open');
  });

  it('sends a close request (Escape, Android Back) to onCancel when given; Close and the backdrop still call onClose', () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(
      <Dialog open onClose={onClose} onCancel={onCancel} title="Choose spells">
        <Button>Back to the spells</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Choose spells' });
    // What a browser's Escape (or Android Back, with no key press) fires at a modal <dialog>.
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows the dialog again, focus back in it, when the browser closes it anyway after an onCancel that kept it open', () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    render(
      <Dialog open onClose={onClose} onCancel={onCancel} title="Choose spells">
        <Button>About Web</Button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Choose spells' });
    const about = screen.getByRole('button', { name: 'About Web' });
    about.focus();
    forceNativeClose(dialog);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute('open');
    expect(about).toHaveFocus();
  });

  it('stays closed when its owner closes it there and then (flushSync) as the browser closes it', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    function Notes() {
      const [open, setOpen] = useState(true);
      return <Dialog open={open} onClose={() => flushSync(() => setOpen(false))} title="Notes" />;
    }
    render(<Notes />);
    const dialog = screen.getByRole('dialog', { name: 'Notes' });
    expect(showModal).toHaveBeenCalledTimes(1);
    // A close with no cancel event first (the browser's own): the owner is told, and closes it at once.
    act(() => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    });
    expect(dialog).not.toHaveAttribute('open');
    expect(showModal).toHaveBeenCalledTimes(1);
  });

  it('closes a dialog before it is removed while open, so focus can return to the opener', () => {
    const connectedAtClose: boolean[] = [];
    const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) {
      connectedAtClose.push(this.isConnected);
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    });
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    function Host({ asking }: { asking: boolean }) {
      return asking ? (
        <Dialog open onClose={() => {}} dismissible={false} title="Roll">
          <Button>Roll</Button>
        </Dialog>
      ) : null;
    }
    const { rerender } = render(<Host asking />);
    expect(showModal).toHaveBeenCalledTimes(1);

    rerender(<Host asking={false} />);
    expect(close).toHaveBeenCalledTimes(1);
    expect(connectedAtClose).toEqual([true]);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes on a backdrop click, but not when a drag from inside ends on the backdrop', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Table rules">
        <textarea aria-label="Setting notes" defaultValue="A coastal frontier town." />
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Table rules' });
    const notes = screen.getByLabelText('Setting notes');

    // Selecting text: the press starts in the field, the release lands on the backdrop, and the
    // browser fires the click at the dialog (their common ancestor).
    fireEvent.pointerDown(notes);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores backdrop clicks on a locked dialog', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} dismissible={false} title="Short rest" />);
    const dialog = screen.getByRole('dialog', { name: 'Short rest' });
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('form controls', () => {
  it('use at least 16px text on phones so iOS Safari does not zoom on focus', () => {
    render(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Backstory" className="font-mono text-xs" />
        <Select aria-label="Kind">
          <option>Spell</option>
        </Select>
      </>,
    );
    for (const label of ['Name', 'Backstory', 'Kind']) {
      expect(screen.getByLabelText(label)).toHaveClass('max-sm:text-base');
    }
    expect(screen.getByLabelText('Name')).toHaveClass('text-sm');
  });
});
