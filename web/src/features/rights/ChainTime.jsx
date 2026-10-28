// Chain timestamps read in the reader's language and time zone (the zone is named), with the exact instant in
// dateTime. `utc` adds the same instant in UTC as selectable text, so a deadline can be copied without converting it.
// A pool the chain returned without a date shows a dash; it must not throw and take the whole panel down.
export function ChainTime({ value, zh, dateOnly = false, utc = false }) {
  const ms = value == null ? NaN : Number(value) * 1000;
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms), locale = zh ? 'zh-CN' : 'en-GB';
  const day = { year: 'numeric', month: 'short', day: 'numeric' };
  if (dateOnly) return <time dateTime={date.toISOString()}>{new Intl.DateTimeFormat(locale, day).format(date)}</time>;
  const text = new Intl.DateTimeFormat(locale, { ...day, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const zone = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value;
  const local = <time dateTime={date.toISOString()}>{zone ? `${text} (${zone})` : text}</time>;
  if (!utc) return local;
  return <span className="chain-time">{local} <code className="chain-time-utc" title={zh ? '协调世界时，可复制' : 'Coordinated Universal Time, copyable'}>{date.toISOString().replace('.000Z', 'Z')}</code></span>;
}
