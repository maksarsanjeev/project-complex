import { useState } from 'react'
import { transport } from '../api/transport'
import { t } from '../i18n'
import { useModel } from '../store/model'

/**
 * Имя, которое можно поправить двойным кликом.
 *
 * Общий компонент для дерева, тегов, материалов и определений: правило одно
 * везде — имя уходит В САМ ДВИЖОК, а потом модель перечитывается. Не «ввёл и
 * подписали»: если движок откажет, в списке останется прежнее. Проверять факт,
 * а не верить успешному вызову, — то самое правило, из-за которого когда-то
 * «тедди возвращён» оказалось неправдой.
 */
export function RenameField({
  id,
  name,
  className,
  disabled,
  title,
  onClick,
  onDoubleClick,
}: {
  /** Идентификатор с приставкой движка; без него переименование недоступно. */
  id?: string
  name: string
  className?: string
  disabled?: boolean
  title?: string
  onClick?: (event: React.MouseEvent) => void
  /** Вызывается вместо начала правки, если переименование запрещено. */
  onDoubleClick?: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const pull = useModel((m) => m.pull)

  const commit = async (value: string): Promise<void> => {
    setEditing(false)
    const next = value.trim()
    if (!next || next === name || !id) return
    setBusy(true)
    try {
      await transport.renameObject({ nodeId: id, name: next })
      // Перечитываем: переименование может изменить структуру — например
      // геометрия вне групп при получении имени становится группой.
      await pull()
    } catch {
      // Движок отказал — ничего не меняем, имя остаётся прежним.
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <input
        className={className}
        autoFocus
        defaultValue={name}
        onBlur={(e) => void commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || busy}
      title={title ?? (id ? t('rename.hint') : t('rename.locked'))}
      onClick={onClick}
      onDoubleClick={() => {
        if (onDoubleClick) return onDoubleClick()
        if (id) setEditing(true)
      }}
    >
      {name}
    </button>
  )
}
