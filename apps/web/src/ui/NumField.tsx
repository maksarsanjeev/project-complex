import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { Label } from './atoms'
import s from './NumField.module.css'

/**
 * Числовое поле с драг-скрабом по лейблу — как в панелях свойств CAD.
 * Значения по всему пайплайну в миллиметрах, поэтому единица подписывается явно.
 */
export function NumField({
  label,
  value,
  unit,
  step = 1,
  onChange,
  disabled = false,
}: {
  label: string
  value: number
  unit?: string
  step?: number
  onChange: (next: number) => void
  disabled?: boolean
}) {
  const drag = useRef<{ x: number; start: number } | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return
    drag.current = { x: e.clientX, start: value }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // shift — точная подстройка, как в большинстве CAD-панелей
    const factor = e.shiftKey ? 0.1 : 1
    onChange(Math.round((d.start + (e.clientX - d.x) * step * factor) * 100) / 100)
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div className={s.root}>
      <div
        className={s.grip}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title={label}
      >
        <Label>{label}</Label>
      </div>
      <div className={s.field}>
        <input
          className={s.input}
          type="number"
          value={Number.isFinite(value) ? value : 0}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {unit ? <span className={s.unit}>{unit}</span> : null}
      </div>
    </div>
  )
}
