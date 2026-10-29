import { PHONE, useMediaQuery } from '../hooks/useMediaQuery.js';

/** A page's introductory text: always shown on wider screens, one tap away on a phone so the task starts near the top. */
export function PageIntro({ summary, children }) {
  const phone = useMediaQuery(PHONE);
  if (!phone) return children;
  return <details className="page-intro"><summary>{summary}</summary>{children}</details>;
}
