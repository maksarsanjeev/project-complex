import type { ParamSpec, ParamValue } from '@complex/protocol'
import { Label, NumField } from '../ui'
import s from './panels.module.css'

/**
 * Одно поле настройки узла. Вид поля выбирается по типу из каталога, а не
 * угадывается по значению — так исполнитель графа получит данные в известном
 * виде и в известных единицах.
 */
export function ParamField({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec
  value: ParamValue | undefined
  onChange: (next: ParamValue) => void
}) {
  if (spec.type === 'number') {
    const raw = typeof value === 'number' ? value : Number(value ?? 0)
    return (
      <NumField
        label={spec.label}
        value={Number.isFinite(raw) ? raw : 0}
        unit={spec.unit}
        step={spec.step ?? 1}
        onChange={(next) => {
          const min = spec.min ?? Number.NEGATIVE_INFINITY
          const max = spec.max ?? Number.POSITIVE_INFINITY
          onChange(Math.min(max, Math.max(min, next)))
        }}
      />
    )
  }

  if (spec.type === 'boolean') {
    const on = value === true
    return (
      <button
        type="button"
        className={s.toggle}
        data-on={on ? 'true' : undefined}
        onClick={() => onChange(!on)}
      >
        <span className={s.toggleBox} aria-hidden />
        {spec.label}
      </button>
    )
  }

  if (spec.type === 'select') {
    return (
      <div className={s.field}>
        <Label className={s.fieldLabel}>{spec.label}</Label>
        <select
          className={s.selectInput}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(spec.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    )
  }

  // Длинный текст (промпт) удобнее править в многострочном поле.
  const isLong = spec.key === 'text'
  return (
    <div className={s.field} style={isLong ? { gridTemplateColumns: '1fr' } : undefined}>
      <Label className={s.fieldLabel}>{spec.label}</Label>
      {isLong ? (
        <textarea
          className={s.textArea}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={s.textInput}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}
