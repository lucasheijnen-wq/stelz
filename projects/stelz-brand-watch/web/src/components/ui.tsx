import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { PAGE_WIDTH, type PageWidth } from './mediaTokens'

export { CARD_GRID, HAIRLINE_GRID, TILE, PAGE_WIDTH } from './mediaTokens'
export type { TileSize, PageWidth } from './mediaTokens'

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${small ? 'text-[13px]' : 'text-[15px]'}`}>
      <img src="/stelz-logo.png" alt="" className={small ? 'w-6 h-6 object-contain' : 'w-8 h-8 object-contain'} />
      <span className="stelz-display text-[var(--color-ink)]">Stëlz</span>
    </span>
  )
}

export function PageShell({
  title,
  subtitle,
  actions,
  crumbs,
  width = 'default',
  brandMark = true,
  children,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
  /** Trail back out of a detail page. Breadcrumbs, not history.back(): a page
   *  reached from a shared link has no history to go back to. */
  crumbs?: { label: string; to: string }[]
  width?: PageWidth
  /** Detail pages about a person lead with the person, not the brand logo. */
  brandMark?: boolean
  children?: ReactNode
}) {
  return (
    <div className={PAGE_WIDTH[width]}>
      <div className="mb-6 lg:mb-8 pb-5 lg:pb-6 border-b border-[var(--color-border)]">
        {crumbs && crumbs.length > 0 && (
          <nav className="mb-3 flex items-center gap-1.5 text-[11px] text-[var(--color-ink-subtle)]">
            {crumbs.map((c, i) => (
              <span key={c.to} className="flex items-center gap-1.5">
                {i > 0 && <span aria-hidden>›</span>}
                <Link to={c.to} className="hover:text-[var(--color-ink)] hover:underline">{c.label}</Link>
              </span>
            ))}
          </nav>
        )}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 flex items-center gap-4">
            {brandMark && (
              <img
                src="/stelz-logo.png"
                alt="Stëlz"
                className="w-12 h-12 lg:w-14 lg:h-14 shrink-0 object-contain"
              />
            )}
            <div className="min-w-0">
              {subtitle && (
                <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1.5">
                  {subtitle}
                </div>
              )}
              <h1 className="stelz-display text-[24px] sm:text-[28px] lg:text-[32px] leading-none text-[var(--color-ink)]">{title}</h1>
            </div>
          </div>
          {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
}

export function Button({ variant = 'secondary', size = 'md', className = '', ...rest }: ButtonProps) {
  // Stelz button language: primary = solid navy block (like "TOEVOEGEN"),
  // secondary = navy pill outline (like "BEKIJK ALLE SMAKEN").
  const base = 'inline-flex items-center justify-center gap-2 border font-medium uppercase tracking-wide transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
  const sizes = { sm: 'px-3 py-1.5 text-[11px]', md: 'px-4 py-2 text-[12px]' }
  const variants = {
    primary: 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white hover:bg-[#1a2240]',
    secondary: 'rounded-full border-[var(--color-ink)] bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-white',
    ghost: 'border-transparent bg-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] normal-case tracking-normal',
    danger: 'rounded-full border-[var(--color-bad)] bg-transparent text-[var(--color-bad)] hover:bg-[var(--color-bad)] hover:text-white',
  }
  return <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest} />
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'good' | 'warn' | 'bad' | 'muted'
}) {
  const tones = {
    neutral: 'border-[var(--color-border-strong)] text-[var(--color-ink)]',
    accent: 'border-[var(--color-accent)] text-[var(--color-accent)]',
    good: 'border-[var(--color-good)] text-[var(--color-good)]',
    warn: 'border-[var(--color-warn)] text-[var(--color-warn)]',
    bad: 'border-[var(--color-bad)] text-[var(--color-bad)]',
    muted: 'border-[var(--color-border)] text-[var(--color-ink-muted)]',
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider border ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function StatCard({ label, value, delta }: { label: string; value: string; delta?: string }) {
  return (
    <div className="bg-[var(--color-surface)] p-5">
      <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className="text-[26px] font-medium tracking-tight tabular-nums leading-none">{value}</div>
        {delta && <div className="text-[12px] text-[var(--color-ink-muted)] tabular-nums">{delta}</div>}
      </div>
    </div>
  )
}

export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const gridCols = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
    4: 'grid-cols-2 lg:grid-cols-4',
  }
  return (
    <div className={`grid ${gridCols[cols]} gap-px bg-[var(--color-border)] border border-[var(--color-border)]`}>
      {children}
    </div>
  )
}

export function Section({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-10">
      {(title || action) && (
        <div className="flex items-end justify-between mb-3">
          {title && <h2 className="text-[15px] font-medium">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`border border-[var(--color-border)] bg-[var(--color-surface)] ${className}`}>{children}</div>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1.5">{label}</div>
      {children}
      {hint && <div className="mt-1.5 text-[11px] text-[var(--color-ink-subtle)]">{hint}</div>}
    </label>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full border border-[var(--color-border-strong)] bg-white px-3 py-2 text-[14px] outline-none focus:border-[var(--color-ink)] ${props.className ?? ''}`}
    />
  )
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full border border-[var(--color-border-strong)] bg-white px-3 py-2 text-[14px] outline-none focus:border-[var(--color-ink)] resize-y ${props.className ?? ''}`}
    />
  )
}

/**
 * Avatar with a monogram fallback.
 *
 * `Img` falls back to a "NO IMAGE" box, which is right for a missing post
 * photo and wrong for a person: a leaderboard of faces with NO IMAGE stamped
 * across half of them reads as a broken tool, when all that happened is that
 * Instagram's CDN expired the avatar URL (they are short-lived, and we do not
 * mirror them the way we mirror post images).
 *
 * A monogram is not a workaround for missing data — there is no data to be
 * missing. The handle IS the identity; the picture was only ever decoration.
 */
export function Avatar({ src, handle, className = '' }: { src?: string | null; handle: string; className?: string }) {
  const [errored, setErrored] = useState(false)
  const letter = (handle || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?'
  if (!src || errored) {
    return (
      <div
        className={`${className} bg-[var(--color-ink)] text-white flex items-center justify-center font-medium select-none`}
        aria-label={`@${handle}`}
      >
        {letter}
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={`@${handle}`}
      loading="lazy"
      onError={() => setErrored(true)}
      className={`${className} object-cover w-full h-full bg-[var(--color-bg)]`}
    />
  )
}


export function Img({
  src,
  alt = '',
  className = '',
  fit = 'cover',
  priority = false,
  small = false,
}: {
  src?: string | null
  alt?: string
  className?: string
  fit?: 'cover' | 'contain'
  /** Hero image: fetch it eagerly and ahead of the grid below it. */
  priority?: boolean
  /** A 48px strip should not compete with the hero for bandwidth. */
  small?: boolean
}) {
  const [errored, setErrored] = useState(false)
  if (!src || errored) {
    // w-full h-full is NOT optional here: without it the fallback collapses to
    // text height inside an aspect box, so a feed whose Instagram CDN URLs have
    // expired renders as a row of slivers and looks broken rather than empty.
    return (
      <div className={`${className} w-full h-full bg-[var(--color-bg)] border border-[var(--color-border)] flex items-center justify-center text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)]`}>
        geen beeld
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={priority ? 'high' : small ? 'low' : 'auto'}
      onError={() => setErrored(true)}
      className={`${className} ${fit === 'cover' ? 'object-cover' : 'object-contain'} w-full h-full bg-[var(--color-bg)]`}
    />
  )
}

export function Tabs({
  items,
  active,
  onChange,
}: {
  items: { id: string; label: string; count?: number }[]
  active: string
  onChange: (id: string) => void
}) {
  // Stelz category-chip style: navy pill outlines, active = filled navy —
  // matches the HARD ICED TEA / COCKTAILS chips on drinkstelz.com.
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {items.map((it) => {
        const isActive = it.id === active
        return (
          <button
            key={it.id}
            onClick={() => onChange(it.id)}
            className={`rounded-full border px-4 py-1.5 text-[12px] font-medium uppercase tracking-wide transition-colors ${
              isActive
                ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
                : 'border-[var(--color-ink)] bg-transparent text-[var(--color-ink)] hover:bg-[var(--color-ink)] hover:text-white'
            }`}
          >
            {it.label}
            {typeof it.count === 'number' && (
              <span className={`ml-1.5 tabular-nums ${isActive ? 'text-white/70' : 'text-[var(--color-ink-subtle)]'}`}>{it.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function Pill({
  children,
  active = false,
  onClick,
}: {
  children: ReactNode
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-[12px] border ${
        active
          ? 'border-[var(--color-ink)] bg-[var(--color-ink)] text-white'
          : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
      }`}
    >
      {children}
    </button>
  )
}

