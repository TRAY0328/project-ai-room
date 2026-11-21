import { useCallback, useEffect, useRef, useState } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Modal focus trap (spec 17.3): moves focus in, keeps Tab inside, restores the
 * previously focused element on close, and closes on Escape.
 */
export function useFocusTrap(active: boolean, onClose: () => void, initial?: HTMLElement | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    restoreTo.current = (document.activeElement as HTMLElement) ?? null;
    const target = initial ?? focusableWithin(ref.current)[0] ?? ref.current;
    target?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableWithin(ref.current);
      if (items.length === 0) {
        event.preventDefault();
        ref.current?.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !ref.current?.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      restoreTo.current?.focus?.();
    };
  }, [active, onClose, initial]);

  return ref;
}

/** aria-live announcer for async results ("전송 실패", "승인 필요" 등). */
export function useAnnouncer() {
  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => {
    setMessage("");
    window.setTimeout(() => setMessage(text), 30);
  }, []);
  return { message, announce };
}

export interface RovingOptions {
  length: number;
  orientation?: "horizontal" | "vertical";
  onActivate?: (index: number) => void;
}

/** Roving tabindex for toolbars/tabs; arrow keys move, Home/End jump. */
export function useRovingTabIndex({ length, orientation = "horizontal", onActivate }: RovingOptions) {
  const [index, setIndex] = useState(0);
  const refs = useRef<Array<HTMLElement | null>>([]);

  const setRef = useCallback((i: number) => (el: HTMLElement | null) => {
    refs.current[i] = el;
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    const prev = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    let target: number | null = null;
    if (event.key === next) target = (index + 1) % length;
    else if (event.key === prev) target = (index - 1 + length) % length;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = length - 1;
    if (target === null) return;
    event.preventDefault();
    setIndex(target);
    refs.current[target]?.focus();
    onActivate?.(target);
  }, [index, length, onActivate, orientation]);

  return { index, setIndex, setRef, onKeyDown, tabIndexFor: (i: number) => (i === index ? 0 : -1) };
}

/** Media query hook used for the mobile drawer (spec 17.3: no fixed resolution). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window === "undefined" || !window.matchMedia ? false : window.matchMedia(query).matches));
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
