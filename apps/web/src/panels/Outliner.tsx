import { Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { transport } from '../api/transport'
import { t } from '../i18n'
import { useEngines } from '../store/engine'
import { useViewport, type PartId } from '../store/viewport'
import { useModel } from '../store/model'
import { buildSceneTree, flatParts, treeFromSnapshot } from '../viewport/sceneTree'
import { IconButton, Label } from '../ui'
import s from './panels.module.css'

/**
 * Дерево сцены. Строится из реальной модели вьюпорта, поэтому видимость и
 * блокировка здесь управляют настоящей геометрией, а не только строкой списка.
 * Слои названы по МАТЕРИАЛУ — так материал назначается одним кликом.
 */
export function Outliner() {
  const params = useViewport((v) => v.params)
  const hidden = useViewport((v) => v.hidden)
  const locked = useViewport((v) => v.locked)
  const selected = useViewport((v) => v.selected)
  const toggleHidden = useViewport((v) => v.toggleHidden)
  const toggleLocked = useViewport((v) => v.toggleLocked)
  const select = useViewport((v) => v.select)
  const selectMany = useViewport((v) => v.selectMany)
  const [editing, setEditing] = useState<string | null>(null)
  const pull = useModel((m) => m.pull)

  /**
   * Имя уходит в сам движок, а не остаётся подписью в списке. После успеха
   * перечитываем модель: у россыпи граней имени в SketchUp нет, и присвоение
   * имени превращает её в группу — идентификатор узла меняется, и знать об
   * этом должен снимок, а не мы на глазок.
   */
  const commitRename = async (nodeId: string, value: string) => {
    setEditing(null)
    const name = value.trim()
    const current = tree.flatMap((l) => l.parts).find((p) => p.id === nodeId)?.name
    if (!name || name === current) return
    try {
      await transport.renameObject({ nodeId, name })
      await pull()
    } catch {
      // Движок отказал — снимок не трогаем, в списке остаётся прежнее имя.
    }
  }

  // Есть снимок из движка — показываем его. Демо-башня остаётся для пустой
  // сессии, чтобы панель не выглядела сломанной, пока движок не подключён.
  const snapshot = useModel((m) => m.snapshot)
  // Правило то же, что во вьюпорте: демо-башня существует только для движков
  // с параметрикой. Иначе получалось расхождение — сцена пустая, а в дереве
  // ядро жёсткости и диагрид, которых нигде нет.
  const parametric = useEngines((e) => e.boundEngine) !== 'sketchup'
  const tree = useMemo(
    () => (snapshot ? treeFromSnapshot(snapshot) : parametric ? buildSceneTree(params) : []),
    [snapshot, parametric, params],
  )

  // Считаем и видимое, и всё: иначе цифра в шапке расходится со счётчиком
  // вьюпорта, и непонятно, какая из них правильная.
  const { visible, total } = useMemo(() => {
    const parts = flatParts(tree)
    return {
      total: parts.reduce((sum, p) => sum + p.triangles, 0),
      visible: parts.reduce((sum, p) => sum + (hidden[p.id] ? 0 : p.triangles), 0),
    }
  }, [tree, hidden])

  /**
   * Слой переключается целиком: если видна хоть одна часть — гасим все,
   * иначе показываем все. Та же логика для блокировки.
   */
  const toggleLayer = (
    ids: PartId[],
    flags: Record<PartId, boolean>,
    toggle: (id: PartId) => void,
  ) => {
    const target = ids.some((id) => !flags[id])
    for (const id of ids) if (flags[id] !== target) toggle(id)
  }

  return (
    <>
      <div className={s.search}>
        <Label tone="strong">{t('rail.outliner')}</Label>
        <span style={{ marginLeft: 'auto' }}>
          <Label>
            {visible === total
              ? `${total.toLocaleString('ru-RU')} ${t('outliner.polygons')}`
              : `${visible.toLocaleString('ru-RU')} ${t('outliner.hiddenOf')} ${total.toLocaleString('ru-RU')} ${t('outliner.polygons')}`}
          </Label>
        </span>
      </div>

      <div className={s.scroll}>
        {tree.length === 0 ? <Label tone="muted">{t('outliner.empty')}</Label> : null}
        {tree.map((layer) => {
          const ids = layer.parts.map((p) => p.id)
          const layerHidden = ids.every((id) => hidden[id])
          const layerLocked = ids.every((id) => locked[id])
          const layerTris = layer.parts.reduce((sum, p) => sum + p.triangles, 0)

          return (
            <div key={layer.material}>
              <div
                className={s.node}
                data-layer="true"
                data-visible={layerHidden ? 'false' : 'true'}
              >
                <span className={s.nodeIndent} style={{ width: 8 }} />
                {/* Клик по слою выделяет всё, что в нём: с материалом обычно
                    работают целиком, а не по одной детали. */}
                <button
                  type="button"
                  className={s.nodeName}
                  title={t('outliner.selectLayer')}
                  onClick={() => selectMany(ids.filter((id) => !locked[id]))}
                >
                  {layer.material}
                </button>
                <span className={s.nodeTris}>{layerTris.toLocaleString('ru-RU')}</span>
                <span className={s.nodeBtns}>
                  <IconButton
                    onClick={() => toggleLayer(ids, hidden, toggleHidden)}
                    title={t('outliner.visibility')}
                  >
                    {layerHidden ? <EyeOff size={12} strokeWidth={1} /> : <Eye size={12} strokeWidth={1} />}
                  </IconButton>
                  <IconButton
                    onClick={() => toggleLayer(ids, locked, toggleLocked)}
                    title={t('outliner.lock')}
                  >
                    {layerLocked ? <Lock size={12} strokeWidth={1} /> : <Unlock size={12} strokeWidth={1} />}
                  </IconButton>
                </span>
              </div>

              {layer.parts.map((part) => (
                <div
                  key={part.id}
                  className={s.node}
                  data-visible={hidden[part.id] ? 'false' : 'true'}
                  data-selected={selected.includes(part.id) || undefined}
                >
                  <span className={s.nodeIndent} style={{ width: 22 }} />
                  {/* Двойной клик переименовывает — привычно по любому дереву. */}
                  {editing === part.id ? (
                    <input
                      className={s.nodeName}
                      autoFocus
                      defaultValue={part.name}
                      onBlur={(e) => void commitRename(part.id, e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    /* Заблокированную часть нельзя выделить и отсюда, а не только в сцене. */
                    <button
                      type="button"
                      className={s.nodeName}
                      title={locked[part.id] ? t('outliner.lockedHint') : t('outliner.renameHint')}
                      disabled={locked[part.id]}
                      onClick={(e) => select(part.id, e.ctrlKey || e.metaKey || e.shiftKey)}
                      onDoubleClick={() => setEditing(part.id)}
                    >
                      {part.name}
                    </button>
                  )}
                  <span className={s.nodeTris}>{part.triangles.toLocaleString('ru-RU')}</span>
                  <span className={s.nodeBtns}>
                    <IconButton onClick={() => toggleHidden(part.id)} title={t('outliner.visibility')}>
                      {hidden[part.id] ? (
                        <EyeOff size={12} strokeWidth={1} />
                      ) : (
                        <Eye size={12} strokeWidth={1} />
                      )}
                    </IconButton>
                    <IconButton onClick={() => toggleLocked(part.id)} title={t('outliner.lock')}>
                      {locked[part.id] ? (
                        <Lock size={12} strokeWidth={1} />
                      ) : (
                        <Unlock size={12} strokeWidth={1} />
                      )}
                    </IconButton>
                  </span>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}
