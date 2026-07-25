import type { ButtonHTMLAttributes, ReactNode } from 'react'
import s from './atoms.module.css'

export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ')

/* ── микро-лейбл ──────────────────────────────────────────────── */

export function Label({
  children,
  tone = 'muted',
  className,
}: {
  children: ReactNode
  tone?: 'muted' | 'ink2' | 'strong'
  className?: string
}) {
  return (
    <span
      className={cx(
        s.label,
        tone === 'strong' && s['label--strong'],
        tone === 'ink2' && s['label--ink2'],
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ── ID-чип ───────────────────────────────────────────────────── */

export function IdChip({ children, invert = false }: { children: ReactNode; invert?: boolean }) {
  return <span className={cx(s.chip, invert && s['chip--invert'])}>{children}</span>
}

/* ── метка состояния ──────────────────────────────────────────── */

export type MarkState = 'idle' | 'running' | 'ok' | 'error'

export function StatusMark({ state, title }: { state: MarkState; title?: string }) {
  return <span className={cx(s.mark, s[`mark--${state}`])} title={title} aria-hidden />
}

/* ── угловые засечки ──────────────────────────────────────────── */

export function Corners() {
  return (
    <span className={s.corners} aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </span>
  )
}

/* ── кнопка-иконка ────────────────────────────────────────────── */

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  text?: string
}

export function IconButton({ active, text, children, className, ...rest }: IconButtonProps) {
  return (
    <button type="button" data-active={active ? 'true' : undefined} className={cx(s.iconBtn, className)} {...rest}>
      {children}
      {text ? <span className={s.iconBtnText}>{text}</span> : null}
    </button>
  )
}

/* ── прочее ───────────────────────────────────────────────────── */

export const Rule = () => <div className={s.rule} aria-hidden />
export const Spacer = () => <div className={s.spacer} aria-hidden />
