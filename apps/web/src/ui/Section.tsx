import { useState, type ReactNode } from 'react'
import { Label } from './atoms'
import s from './Section.module.css'

/** Секция-аккордеон правой панели. */
export function Section({
  title,
  meta,
  defaultOpen = true,
  children,
}: {
  title: string
  /** Правый угол шапки: счётчик, чип, статус. */
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={s.root}>
      <button type="button" className={s.head} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={s.caret} data-open={open ? 'true' : 'false'} aria-hidden />
        <Label tone="strong">{title}</Label>
        {meta ? <span className={s.count}>{meta}</span> : null}
      </button>
      {open ? <div className={s.body}>{children}</div> : null}
    </div>
  )
}
