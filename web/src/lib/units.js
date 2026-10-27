// What people type in role forms, and the exact values the chain records.

/** "8.5" TEST_USDC -> "8500000" atomic units (six decimals); '' unless a positive amount with at most six decimals. */
export function toAtomic(text) {
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/u.exec(String(text ?? '').trim());
  if (!match) return '';
  const value = BigInt(match[1]) * 1000000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return value > 0n ? value.toString() : '';
}

/** The value of <input type="datetime-local"> (the reader's local time) -> Unix seconds, or ''. */
export function toUnixSeconds(local) {
  const ms = local ? Date.parse(local) : NaN;
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : '';
}
