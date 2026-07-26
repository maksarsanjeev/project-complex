import { Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { useMemo } from 'react'
import { t } from '../i18n'
import { useEngines } from '../store/engine'
import { useModel } from '../store/model'
import { RenameField } from './RenameField'
import { useViewport, type PartId } from '../store/viewport'
import { rowsFromSnapshots, rowsFromTower, type SceneRow } from '../viewport/sceneTree'
import { IconButton, Label } from '../ui'
import s from './panels.module.css'

/**
 * Дерево сцены — по ВЛОЖЕННОСТИ, как в самом SketchUp.
 *
 * Раньше корнем были слои: группа лежала «внутри» слоя. Это привычно по Rhino
 * и AutoCAD, но для SketchUp неверно — тег там ничего не содержит, он лишь
 * помечает объект для управления видимостью. Вкладывать умеют только группа и
 * компонент, и родной аутлайнер показывает ровно их. Тег стал пометкой на
 * строке, а не веткой.
 *
 * Видимость и блокировка действуют на настоящую геометрию, а не на строку списка.
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

  const snapshots = useModel((m) => m.snapshots)

  // Демо-башня существует только для движков с параметрикой — там же, где
  // панель «параметры модели». С привязанным SketchUp сцена пуста, пока модель
  // не забрана: показывать чужую демо-модель значит выдавать её за проект.
  const parametric = useEngines((e) => e.boundEngine) !== 'sketchup'

  const rows = useMemo(
    () => (snapshots.length ? rowsFromSnapshots(snapshots) : parametric ? rowsFromTower(params) : []),
    [snapshots, parametric, params],
  )

  const { visible, total } = useMemo(
    () => ({
      // Считаем по листьям: у контейнера треугольники уже просуммированы с
      // потомками, и сложение всех подряд дало бы двойной счёт.
      total: rows.filter((r) => r.kind !== 'layer').reduce((sum, r) => sum + r.triangles, 0),
      visible: rows
        .filter((r) => r.kind !== 'layer')
        .reduce((sum, r) => sum + (hidden[r.id] ? 0 : r.triangles), 0),
    }),
    [rows, hidden],
  )

  /** Строки ветки: сам контейнер и всё, что вложено в него. */
  const branchIds = (row: SceneRow, index: number): PartId[] => {
    const ids = [row.id]
    for (let i = index + 1; i < rows.length; i++) {
      const next = rows[i]
      if (!next || next.depth <= row.depth) break
      ids.push(next.id)
    }
    return ids
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
        {rows.length === 0 ? <Label tone="muted">{t('outliner.empty')}</Label> : null}

        {rows.map((row, index) => {
          const isContainer = row.kind === 'layer'
          const ids = branchIds(row, index)

          return (
            <div
              key={row.id}
              className={s.node}
              data-layer={isContainer || undefined}
              data-visible={hidden[row.id] ? 'false' : 'true'}
              data-selected={selected.includes(row.id) || undefined}
            >
              {/* Отступ по глубине: вложенность в модели произвольная. */}
              <span className={s.nodeIndent} style={{ width: 8 + row.depth * 14 }} />

              <RenameField
                /* Корень движка — не объект модели, переименовывать нечего. */
                id={row.kind === 'engine' ? undefined : row.id}
                name={row.name}
                className={s.nodeName}
                disabled={locked[row.id]}
                title={
                  locked[row.id]
                    ? t('outliner.lockedHint')
                    : row.kind === 'engine'
                      ? t('outliner.engineRoot')
                      : undefined
                }
                onClick={(e) =>
                  isContainer
                    ? selectMany(ids.filter((id) => !locked[id]))
                    : select(row.id, (e as React.MouseEvent).ctrlKey || (e as React.MouseEvent).metaKey || (e as React.MouseEvent).shiftKey)
                }
              />

              {/* Тег и связанность компонента — пометками, а не ветками дерева. */}
              {row.tag && row.tag !== 'Layer0' ? (
                <span className={s.nodeTag} title={t('outliner.tag')}>
                  {row.tag}
                </span>
              ) : null}
              {row.instances && row.instances > 1 ? (
                <span className={s.nodeTag} title={t('outliner.linked')}>
                  ×{row.instances}
                </span>
              ) : null}

              <span className={s.nodeTris}>{row.triangles.toLocaleString('ru-RU')}</span>
              <span className={s.nodeBtns}>
                <IconButton
                  onClick={() =>
                    ids.forEach((id) => {
                      if (hidden[id] === hidden[row.id]) toggleHidden(id)
                    })
                  }
                  title={t('outliner.visibility')}
                >
                  {hidden[row.id] ? (
                    <EyeOff size={12} strokeWidth={1} />
                  ) : (
                    <Eye size={12} strokeWidth={1} />
                  )}
                </IconButton>
                <IconButton
                  onClick={() =>
                    ids.forEach((id) => {
                      if (locked[id] === locked[row.id]) toggleLocked(id)
                    })
                  }
                  title={t('outliner.lock')}
                >
                  {locked[row.id] ? (
                    <Lock size={12} strokeWidth={1} />
                  ) : (
                    <Unlock size={12} strokeWidth={1} />
                  )}
                </IconButton>
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
