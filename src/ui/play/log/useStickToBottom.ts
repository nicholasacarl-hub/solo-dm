import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** How close (px) to the bottom still counts as "reading the latest". */
const NEAR_BOTTOM_PX = 96;

export interface StickToBottom {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  onScroll: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

/**
 * Keep a scroll container pinned to the bottom while the reader is near it (streaming text grows
 * the last entry, so content size is watched with a ResizeObserver), and report when they have
 * scrolled away so the UI can offer "Jump to latest".
 */
export function useStickToBottom(changeKey: unknown): StickToBottom {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    setAtBottom(true);
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    pinnedRef.current = near;
    setAtBottom(near);
  }, []);

  // New entries: follow them if the reader was at the bottom.
  useLayoutEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [changeKey, scrollToBottom]);

  // Growing entries (streaming narration, expanded details, images).
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  return { scrollRef, contentRef, atBottom, onScroll, scrollToBottom };
}
