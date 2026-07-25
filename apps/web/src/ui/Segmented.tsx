import { cx } from './atoms'
import s from './Segmented.module.css'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  title?: string
}

/** Переключатель-сегменты: режимы вьюпорта, проекция, API ⇄ CLI. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (next: T) => void
  className?: string
}) {
  return (
    <div className={cx(s.root, className)} role="group">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          title={opt.title}
          aria-pressed={opt.value === value}
          data-active={opt.value === value ? 'true' : undefined}
          className={s.item}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
