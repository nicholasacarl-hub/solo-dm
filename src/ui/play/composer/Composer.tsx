import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { MessageCircle, SendHorizontal, Square } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useGame } from '@/state/gameStore';
import { Button } from '@/ui/components/ui';
import { cancelDm, isBusyPhase, sendToDm } from '../dmStatus';
import { withOocPrefix } from '../format';
import { usePlayView } from '../playView';
import { useIsTouch } from '../useMediaQuery';
import { QuickActions } from './QuickActions';
import { emptySendWords } from './turnWords';
import { XCardButton } from './XCardButton';

/** Tallest the textarea grows before it scrolls. */
const MAX_HEIGHT_PX = 208;

/**
 * The player's input. Desktop: Enter sends, Shift+Enter adds a line. Touch: Enter adds a line and
 * the Send button sends. While the DM is busy, Send becomes Stop. On the hero's battle-map turn an
 * empty Send tells the DM about the hero's moves ("I move to D8.").
 */
export function Composer() {
  const busy = useGame((s) => isBusyPhase(s.dm.phase));
  // A string or null, so streaming narration (which changes the store constantly) doesn't re-render this; while the
  // DM is busy Send is Stop, so there is nothing to work out.
  const moveWords = useGame((s) => (isBusyPhase(s.dm.phase) ? null : emptySendWords(s.combat, s.transcript)));
  const prefill = usePlayView((s) => s.prefill);
  const focusRequest = usePlayView((s) => s.composerFocus);
  // The draft lives in the view store so it survives a remount (crossing the desktop breakpoint).
  const text = usePlayView((s) => s.draft);
  const ooc = usePlayView((s) => s.ooc);
  const { setDraft: setText, setOoc } = usePlayView.getState();
  const isTouch = useIsTouch();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Focus requests made before this composer mounted (it remounts across the desktop breakpoint) are old news.
  const seenFocusRequest = useRef(focusRequest);
  const inputId = useId();
  const hintId = useId();

  // Grow with the text.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  // "Ask a rules question" and friends put text in the box and focus it (one-shot requests).
  useEffect(() => {
    if (!prefill) return;
    usePlayView.setState({ draft: prefill.text, prefill: null });
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = prefill.text.length;
    el.setSelectionRange(end, end);
  }, [prefill]);

  // "Tell the DM", an [Area: …] line and friends focus the box without touching the draft (it may have just grown).
  useEffect(() => {
    if (focusRequest === seenFocusRequest.current) return;
    seenFocusRequest.current = focusRequest;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [focusRequest]);

  const send = async () => {
    const typed = text.trim();
    // An empty Send on the hero's map turn: the hero's moves speak for themselves (in character).
    const words = typed || moveWords;
    if (!words || busy) return;
    setText('');
    const ok = await sendToDm(typed && ooc ? withOocPrefix(typed) : words);
    // The DM refused the message (e.g. no session yet): give the typed words back.
    if (!ok && typed && !usePlayView.getState().draft) setText(typed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || isTouch || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  const canSend = text.trim().length > 0 || moveWords !== null;
  const placeholder = moveWords ?? (ooc ? 'Ask the DM out of character…' : 'What do you do?');

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
        placeholder={placeholder}
        enterKeyHint={isTouch ? 'enter' : 'send'}
        aria-describedby={isTouch ? undefined : hintId}
        className={cn(
          'block max-h-52 min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-1 leading-relaxed text-text outline-none placeholder:text-faint',
          // 16px on phones and touch screens: iOS Safari zooms the page into any smaller focused field.
          isTouch ? 'text-base' : 'text-base sm:text-[0.9375rem]',
        )}
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        <QuickActions busy={busy} />
        <button
          type="button"
          aria-pressed={ooc}
          onClick={() => setOoc(!ooc)}
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
              title={!text.trim() && moveWords ? `Send “${moveWords}”` : undefined}
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
