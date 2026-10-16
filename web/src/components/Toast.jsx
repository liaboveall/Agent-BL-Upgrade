import { useEffect, useRef, useState } from 'react';
import { toastStore } from '../lib/toast.js';
import { useStore } from '../state/hooks.js';
import { cx } from './ui.jsx';

const SHOW_MS = 3800;

/**
 * The visual toast is a manual popover, so it sits in the top layer above any open modal. Screen
 * readers get the same text from a live region that is always in the document.
 */
export function Toast() {
  const { id, message, error } = useStore(toastStore, (state) => state);
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!id) return undefined;
    const node = ref.current;
    try { node?.hidePopover?.(); node?.showPopover?.(); } catch { /* popover unsupported: falls back to a fixed element */ }
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      try { node?.hidePopover?.(); } catch { /* already hidden */ }
    }, SHOW_MS);
    return () => clearTimeout(timer);
  }, [id]);
  return (
    <>
      <div ref={ref} popover="manual" className={cx('toast', error && 'is-error', visible && 'is-visible')} aria-hidden="true">
        {message}
      </div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{visible ? message : ''}</p>
    </>
  );
}
