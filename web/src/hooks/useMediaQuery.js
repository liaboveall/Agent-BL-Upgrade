import { useEffect, useState } from 'react';

const matches = (query) => Boolean(globalThis.matchMedia?.(query).matches);

/** Whether a CSS media query matches now; re-renders when it starts or stops matching. */
export function useMediaQuery(query) {
  const [value, setValue] = useState(() => matches(query));
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setValue(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return value;
}

// Below these widths the market shows one column (the detail opens as a sheet) and the phone layout applies.
export const SINGLE_COLUMN = '(max-width: 959px)';
export const PHONE = '(max-width: 767px)';
