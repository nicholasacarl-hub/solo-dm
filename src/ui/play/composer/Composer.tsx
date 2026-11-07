import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MessageCircle, SendHorizontal, Square } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { Button } from '@/ui/components/ui';
import { cancelDm, isBusyPhase, sendToDm } from '../dmStatus';
import { withOocPrefix } from '../format';
import { usePlayView } from '../playView';
import { useIsTouch } from '../useMediaQuery';
import { QuickActions } from './QuickActions';
import { XCardButton } from './XCardButton';

/** Tallest the textarea grows before it scrolls. */
const MAX_HEIGHT_PX = 208;

/**
 * The player's input. Desktop: Enter sends, Shift+Enter adds a line. Touch: Enter adds a line and
 * the Send button sends. While the DM is busy, Send becomes Stop.
 */
export function Composer() {
  const busy = useGame((s) => isBusyPhase(s.dm.phase));
  const prefill = usePlayView((s) => s.prefill);
  const isTouch = useIsTouch();
  const [text, setText] = useState('');
  const [ooc, setOoc] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const hintId = useId();

  // Grow with the text.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  // "Ask a rules question" and friends put text in the box and focus it.
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = prefill.text.length;
    el.setSelectionRange(end, end);
  }, [prefill]);

  const send = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setText('');
    const ok = await sendToDm(ooc ? withOocPrefix(words) : words);
    // The DM refused the message (e.g. no session yet): give the words back.
    if (!ok) setText((current) => current || words);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || isTouch || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  const canSend = text.trim().length > 0;

  // Not a <form>: the X-card popover and the roll dialog inside the toolbar have forms of their own.
  return (
    <div
      className={cn(
        'relative rounded-2xl border bg-surface shadow-card transition-colors focus-within:border-accent',
        ooc ? 'border-dashed border-info' : 'border-border',
      )}
    >
      <label htmlFor={inputId} className="sr-only">
        {ooc ? 'Out-of-character message to the DM' : 'What do you do?'}
      </label>
      <textarea
        id={inputId}
        ref={textareaRef}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={ooc ? 'Ask the DM out of character…' : 'What do you do?'}
        enterKeyHint={isTouch ? 'enter' : 'send'}
        aria-describedby={isTouch ? undefined : hintId}
        className="block max-h-52 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[0.9375rem] leading-relaxed text-text outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <QuickActions busy={busy} />
        <button
          type="button"
          aria-pressed={ooc}
          onClick={() => setOoc((v) => !v)}
          title="Out of character: talk to the DM, not the world"
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold tracking-wide whitespace-nowrap transition-colors',
            ooc ? 'bg-info-soft text-info' : 'text-muted hover:bg-surface-2 hover:text-text',
          )}
        >
          <MessageCircle className="size-4" aria-hidden />
          OOC
        </button>
        <XCardButton />
        {!isTouch && (
          <span id={hintId} className="ml-auto hidden truncate px-2 text-xs text-faint xl:inline">
            Shift+Enter for a new line
          </span>
        )}
        <div className={cn('shrink-0', isTouch ? 'ml-auto' : 'ml-auto xl:ml-0')}>
          {busy ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={cancelDm}
              icon={<Square className="size-3.5 fill-current" aria-hidden />}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={!canSend}
              onClick={() => void send()}
              icon={<SendHorizontal className="size-4" aria-hidden />}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
