/**
 * "Paint portrait": the image model paints the hero from their sheet (species, class, appearance,
 * gear) in the campaign's art style. The player sees the new portrait before it replaces the one
 * they chose; the full-size picture is kept in the Gallery either way.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Paintbrush, RotateCcw } from 'lucide-react';
import { generatePortrait } from '@/images';
import { useGame } from '@/state/gameStore';
import type { Character } from '@/types';
import { toast } from '@/ui/components/toast';
import { Button, Dialog } from '@/ui/components/ui';
import { Portrait } from './Portrait';
import { useSheetEdit } from './useSheetActions';

type Painting =
  | { step: 'idle' }
  | { step: 'painting' }
  | { step: 'done'; portrait: string }
  | { step: 'error'; message: string };

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The portrait could not be painted.';
}

/** Paint with the image model; closing the dialog (or Stop) abandons the painting. */
function usePortraitPainter(character: Character) {
  const campaign = useGame((s) => s.campaign);
  const [painting, setPainting] = useState<Painting>({ step: 'idle' });
  const controller = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const paint = async () => {
    if (!campaign) return;
    stop();
    const own = new AbortController();
    controller.current = own;
    setPainting({ step: 'painting' });
    try {
      const { portrait } = await generatePortrait(character, campaign, own.signal);
      if (!own.signal.aborted) setPainting({ step: 'done', portrait });
    } catch (err) {
      // Our own Stop / close already moved on; a cancellation from elsewhere just ends the painting.
      if (!own.signal.aborted) setPainting(isAbort(err) ? { step: 'idle' } : { step: 'error', message: errorText(err) });
    } finally {
      if (controller.current === own) controller.current = null;
    }
  };

  const reset = () => {
    stop();
    setPainting({ step: 'idle' });
  };

  return { painting, paint, reset };
}

export function PortraitDialog({ open, onClose, character }: { open: boolean; onClose: () => void; character: Character }) {
  const { painting, paint, reset } = usePortraitPainter(character);
  const edit = useSheetEdit();
  const [saving, setSaving] = useState(false);
  const name = character.name || 'your hero';

  const close = () => {
    reset();
    onClose();
  };

  const use = async () => {
    if (painting.step !== 'done') return;
    setSaving(true);
    // The portrait is just a picture: the DM doesn't need to hear about it.
    const saved = await edit((c) => ({ character: { ...c, portrait: painting.portrait }, notice: null }));
    setSaving(false);
    if (!saved) return;
    toast.success('New portrait set. The full picture is in the Gallery.');
    close();
  };

  const busy = painting.step === 'painting';
  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title="Paint a portrait"
      description="Painted from your sheet (species, class, appearance and gear) in this campaign’s art style."
      footer={
        busy ? (
          <Button onClick={reset}>Stop</Button>
        ) : painting.step === 'done' ? (
          <>
            <Button onClick={() => void paint()} icon={<RotateCcw className="size-4" aria-hidden />} disabled={saving}>
              Paint again
            </Button>
            <Button variant="primary" onClick={() => void use()} loading={saving}>
              Use this portrait
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => void paint()} icon={<Paintbrush className="size-4" aria-hidden />}>
            {painting.step === 'error' ? 'Try again' : 'Paint portrait'}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-center gap-4">
          <figure className="flex flex-col items-center gap-1.5">
            <Portrait portrait={character.portrait} size="xl" />
            <figcaption className="text-xs text-muted">Now</figcaption>
          </figure>
          <figure className="flex flex-col items-center gap-1.5">
            {painting.step === 'done' ? (
              <img
                src={painting.portrait}
                alt={`New portrait of ${name}`}
                className="size-32 rounded-2xl border border-border object-cover"
              />
            ) : (
              <div className="grid size-32 place-items-center rounded-2xl border border-dashed border-border bg-surface-2 text-faint">
                <Paintbrush className={busy ? 'size-7 text-muted motion-safe:animate-pulse' : 'size-7'} aria-hidden />
              </div>
            )}
            <figcaption className="text-xs text-muted">New</figcaption>
          </figure>
        </div>
        <PaintingStatus painting={painting} />
      </div>
    </Dialog>
  );
}

function PaintingStatus({ painting }: { painting: Painting }) {
  switch (painting.step) {
    case 'idle':
      return (
        <p className="text-sm text-muted">
          It takes up to a minute and costs a few cents on your OpenAI account. You choose whether to keep it.
        </p>
      );
    case 'painting':
      return (
        <p role="status" className="text-sm text-muted">
          Painting your portrait… this can take up to a minute.
        </p>
      );
    case 'done':
      return <p className="text-sm text-muted">Keep it? It replaces your current portrait. The full picture is saved in the Gallery either way.</p>;
    case 'error':
      return (
        <p role="alert" className="text-sm text-danger">
          {painting.message}
        </p>
      );
  }
}
