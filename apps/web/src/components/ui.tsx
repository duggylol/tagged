import { describeStatus, formatCents, getPlatform, type ItemStatus, type ListingState, type PlatformId } from '@tagged/core';
import type { ReactNode } from 'react';

/** Shared primitives. Deliberately small — the pages carry the layout. */

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={`rounded-xl border border-hair bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] ${className}`}
    >
      {children}
    </Tag>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow mb-2">{children}</p>;
}

export function Money({
  cents,
  className = '',
  signed = false,
}: {
  cents: number;
  className?: string;
  signed?: boolean;
}) {
  // Losses are a real outcome in reselling and hiding them helps nobody.
  const tone = signed && cents < 0 ? 'text-rust' : signed && cents > 0 ? 'text-accent' : '';
  return <span className={`tnum ${tone} ${className}`}>{formatCents(cents)}</span>;
}

/**
 * A metric that reads at a glance. `hint` carries the thing the number does
 * not say on its own — "after fees", "of 34 listed".
 */
export function Metric({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const valueTone =
    tone === 'good' ? 'text-accent' : tone === 'warn' ? 'text-amber' : tone === 'bad' ? 'text-rust' : 'text-ink';

  return (
    <Card>
      <p className="eyebrow">{label}</p>
      <p className={`mt-1.5 font-display text-2xl font-extrabold leading-none tnum ${valueTone}`}>
        {value}
      </p>
      {hint ? <p className="mt-1.5 text-xs text-mute">{hint}</p> : null}
    </Card>
  );
}

const STATUS_TONE: Record<ItemStatus, string> = {
  draft: 'bg-sunk text-mute',
  active: 'bg-accent-soft text-accent',
  sale_detected: 'bg-amber-soft text-amber',
  delist_pending: 'bg-amber-soft text-amber',
  awaiting_confirm: 'bg-amber-soft text-amber',
  sold: 'bg-accent-soft text-accent',
  relisting: 'bg-amber-soft text-amber',
  archived: 'bg-sunk text-mute',
};

export function StatusPill({ status, showHint = false }: { status: ItemStatus; showHint?: boolean }) {
  const { label, hint } = describeStatus(status);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={`inline-block rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.09em] ${STATUS_TONE[status]}`}
      >
        {label}
      </span>
      {showHint ? <span className="text-xs text-mute">{hint}</span> : null}
    </span>
  );
}

const LISTING_TONE: Record<ListingState, string> = {
  not_listed: 'border-hair text-mute',
  publishing: 'border-amber text-amber',
  active: 'border-accent text-accent',
  ending: 'border-amber text-amber',
  ended: 'border-hair text-mute',
  sold: 'border-accent bg-accent-soft text-accent',
  error: 'border-rust text-rust',
};

export function PlatformChip({
  platform,
  state,
  onClick,
  selected,
}: {
  platform: PlatformId;
  state?: ListingState;
  onClick?: () => void;
  selected?: boolean;
}) {
  const spec = getPlatform(platform);
  const tone = state ? LISTING_TONE[state] : selected ? 'border-accent bg-accent-soft text-accent' : 'border-hair text-mute';

  const content = (
    <>
      <span className="font-medium">{spec.label}</span>
      {spec.connection === 'extension' ? (
        <span className="font-mono text-[9px] uppercase opacity-60" title="Reached through the browser extension">
          ext
        </span>
      ) : null}
    </>
  );

  const className = `inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${tone}`;

  return onClick ? (
    <button type="button" onClick={onClick} className={`${className} transition-colors`} aria-pressed={selected}>
      {content}
    </button>
  ) : (
    <span className={className}>{content}</span>
  );
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  disabled,
  className = '',
  full,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  className?: string;
  full?: boolean;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45';

  const variants = {
    primary: 'bg-accent text-paper hover:opacity-90',
    secondary: 'border border-hair bg-card text-ink hover:bg-sunk',
    ghost: 'text-mute hover:text-ink',
    danger: 'border border-rust text-rust hover:bg-rust-soft',
  } as const;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variants[variant]} ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1 text-xs text-mute">{hint}</p> : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-hair bg-card px-3 py-2 text-sm text-ink placeholder:text-mute focus:border-accent focus:outline-none';

/**
 * Empty states carry the next action, not an apology. A seller looking at an
 * empty inventory list needs a button, not a shrug.
 */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-hair px-6 py-12 text-center">
      <h3 className="text-base font-bold">{title}</h3>
      <p className="mx-auto mt-2 max-w-sm text-sm text-mute">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: 'border-l-accent bg-accent-soft/40',
    warn: 'border-l-amber bg-amber-soft/40',
    error: 'border-l-rust bg-rust-soft/40',
  } as const;

  return (
    <div className={`rounded-r-lg border border-l-[3px] border-hair p-3 text-sm ${tones[tone]}`}>
      {title ? <p className="mb-1 font-semibold text-ink">{title}</p> : null}
      <div className="text-body">{children}</div>
    </div>
  );
}

/**
 * Confidence is shown, never hidden. Below 0.7 the publish button asks for an
 * explicit review — a wrong listing costs a seller a return and a rating hit.
 */
export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tone = value >= 0.7 ? 'bg-accent' : value >= 0.45 ? 'bg-amber' : 'bg-rust';
  const label = value >= 0.7 ? 'Confident' : value >= 0.45 ? 'Check this' : 'Needs your eyes';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="eyebrow">AI confidence</span>
        <span className="tnum text-xs text-mute">
          {pct}% · {label}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunk">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
