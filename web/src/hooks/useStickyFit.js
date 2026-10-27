import { useEffect } from 'react';

/**
 * A sticky side column taller than the window could never show its bottom, where the primary action lives,
 * until the whole page scrolled past. Lowering `top` by the overflow lets the column scroll with the page
 * until its bottom is in view and only then stick, so the card stays whole and needs no scrollbar of its own.
 * `bottom` keeps the stuck column clear of the floating Copilot button.
 */
export function useStickyFit(ref, { top = 112, bottom = 76 } = {}) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const update = () => {
      const overflow = node.offsetHeight + top + bottom - window.innerHeight;
      node.style.top = `${overflow > 0 ? top - overflow : top}px`;
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(node);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [ref, top, bottom]);
}
