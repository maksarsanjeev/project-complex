import type { ReactNode } from 'react'
import { Label, cx } from './atoms'
import s from './Panel.module.css'

/**
 * Базовая панель: шапка с микро-лейблом и мерными рисками + тело.
 * Ни теней, ни скруглений — только хайрлайны.
 */
export function Panel({
  title,
  chip,
  actions,
  children,
  flush = false,
  className,
}: {
  title: string
  /** ID-чип или счётчик справа от заголовка. */
  chip?: ReactNode
  actions?: ReactNode
  children: ReactNode
  /** true — тело не скроллится (для вьюпорта и графа). */
  flush?: boolean
  className?: string
}) {
  return (
    <section className={cx(s.panel, className)}>
      <header className={s.head}>
        <Label tone="strong">{title}</Label>
        {chip}
        {actions ? <div className={s.actions}>{actions}</div> : null}
      </header>
      <div className={cx(s.body, flush && s['body--flush'])}>{children}</div>
    </section>
  )
}
