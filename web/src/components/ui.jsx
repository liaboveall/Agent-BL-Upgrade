// Shared building blocks. Everything dynamic is rendered as React text (escaped), never as HTML.
import { useEffect, useRef, useState } from 'react';
import { modalFocusWrap, nextChoiceIndex } from '../lib/accessibility.js';
import { t } from '../lib/i18n.js';
import { Icon } from './Icon.jsx';

const cx = (...names) => names.filter(Boolean).join(' ');

export function Button({ variant = 'secondary', size, className, children, type = 'button', ...props }) {
  return <button type={type} className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)} {...props}>{children}</button>;
}

/** tone: ok | warn | crit | info | muted | accent */
export function Badge({ tone = 'muted', className, children, ...props }) {
  return <span className={cx('badge', `tone-${tone}`, className)} {...props}>{children}</span>;
}

export function Card({ as: Tag = 'section', className, children, ...props }) {
  return <Tag className={cx('card', className)} {...props}>{children}</Tag>;
}

export function CardHead({ title, children, level = 2, id }) {
  const Heading = `h${level}`;
  return (
    <header className="card-head">
      <Heading id={id} className="card-title">{title}</Heading>
      {children ? <div className="card-head-side">{children}</div> : null}
    </header>
  );
}

export function Stat({ label, value, tone, hint }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className={cx('stat-value', tone && `text-${tone}`)}>{value}</strong>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

/** A label/value pair inside a definition-style grid. */
export function KV({ label, children, tone, mono }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className={cx('kv-value', tone && `text-${tone}`, mono && 'mono')}>{children ?? '—'}</span>
    </div>
  );
}

export function Progress({ value, tone = 'accent', label, paused }) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100);
  return (
    <div className={cx('progress', paused && 'is-paused')} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <span className={cx('progress-fill', `fill-${tone}`)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      {title ? <strong>{title}</strong> : null}
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** A collapsible secondary section (native details/summary keeps keyboard and screen-reader behaviour). */
export function Disclosure({ summary, children, className, defaultOpen = false, ...props }) {
  return (
    <details className={cx('disclosure', className)} open={defaultOpen || undefined} {...props}>
      <summary><Icon name="chevronRight" size={14} className="disclosure-chevron" />{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** Copy a value and confirm in place; the clipboard may be unavailable (insecure origin), which says so. */
export function CopyButton({ value, label = t('ac_copy') }) {
  const [state, setState] = useState('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), 1200);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="icon-btn copy-btn"
      title={label}
      aria-label={label}
      data-focus-key={`copy:${value}`}
      onClick={async (event) => {
        event.stopPropagation();
        try { await navigator.clipboard.writeText(String(value)); setState('ok'); } catch { setState('fail'); }
      }}
    >
      {state === 'ok' ? <Icon name="check" size={14} /> : state === 'fail' ? '!' : <Icon name="copy" size={14} />}
    </button>
  );
}

/**
 * A modal dialog on the native <dialog> element: the browser makes the rest of the page inert and
 * restores focus to the opener on close; Tab and Shift+Tab wrap inside it.
 */
export function Dialog({ id, open, onClose, labelledBy, label, className, children, variant = 'center' }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')]
      .filter((item) => item.tabIndex >= 0 && !item.disabled && item.getClientRects().length && !item.closest('[inert]'));
    const target = modalFocusWrap(items, document.activeElement, event.shiftKey);
    if (target) { event.preventDefault(); target.focus(); }
  };
  return (
    <dialog
      ref={ref}
      id={id}
      className={cx('dialog', `dialog-${variant}`, className)}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      onClose={() => { if (open) onClose?.(); }}
      onKeyDown={onKeyDown}
      onClick={(event) => { if (event.target === ref.current) onClose?.(); }}
    >
      {open ? <div className="dialog-surface">{children}</div> : null}
    </dialog>
  );
}

export function DialogHeader({ id, title, subtitle, onClose, children }) {
  return (
    <header className="dialog-head">
      <div className="dialog-head-text">
        <h2 id={id}>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {children}
      <button type="button" className="icon-btn" onClick={onClose} aria-label={t('modal_close')} title={t('modal_close')}>
        <Icon name="close" size={18} />
      </button>
    </header>
  );
}

/**
 * Roving-focus choice group (tabs or radios): arrow keys, Home and End move the selection and the
 * focus together; only the selected choice is in the Tab order.
 */
export function useRovingKeys(options, selected, onSelect, { disabled = () => false } = {}) {
  const refs = useRef([]);
  const onKeyDown = (event) => {
    const index = options.indexOf(event.target.closest('[data-choice]')?.dataset.choice);
    const next = nextChoiceIndex(event, index, options.map((option) => disabled(option)));
    if (next < 0) return;
    event.preventDefault();
    onSelect(options[next]);
    refs.current[next]?.focus();
  };
  const choiceProps = (option, index) => ({
    ref: (node) => { refs.current[index] = node; },
    'data-choice': option,
    tabIndex: option === selected ? 0 : -1
  });
  return { onKeyDown, choiceProps };
}

/** Segmented control backed by role="radiogroup". options: [{ value, label, hint, disabled }] */
export function Segmented({ options, value, onChange, label, className }) {
  const values = options.map((option) => option.value);
  const { onKeyDown, choiceProps } = useRovingKeys(values, value, onChange, { disabled: (v) => options.find((o) => o.value === v)?.disabled });
  return (
    <div className={cx('segmented', className)} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={option.disabled}
          className={cx('segment', option.value === value && 'is-active')}
          onClick={() => onChange(option.value)}
          {...choiceProps(option.value, index)}
        >
          <span>{option.label}</span>
          {option.hint ? <small>{option.hint}</small> : null}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, htmlFor, hint, children, className }) {
  return (
    <div className={cx('field', className)}>
      {label ? <label htmlFor={htmlFor} className="field-label">{label}</label> : null}
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

export function Spinner({ label }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function ExternalLink({ href, children, className }) {
  return (
    <a className={cx('ext-link', className)} href={href} target="_blank" rel="noopener noreferrer">
      {children}<Icon name="external" size={12} />
    </a>
  );
}

export { cx };
