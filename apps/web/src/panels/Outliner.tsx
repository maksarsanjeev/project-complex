import { Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { useMemo } from 'react'
import { t } from '../i18n'
import { useViewport, type PartId } from '../store/viewport'
import { buildSceneTree, flatParts } from '../viewport/sceneTree'
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

  const tree = useMemo(() => buildSceneTree(params), [params])
  const total = useMemo(
    () => flatParts(tree).reduce((sum, part) => sum + part.triangles, 0),
    [tree],
  )

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
          <Label>{total.toLocaleString('ru-RU')} тр</Label>
        </span>
      </div>

      <div className={s.scroll}>
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
                <span className={s.nodeName} title={layer.material}>
                  {layer.material}
                </span>
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
                  data-selected={selected === part.id || undefined}
                >
                  <span className={s.nodeIndent} style={{ width: 22 }} />
                  <button
                    type="button"
                    className={s.nodeName}
                    title={part.name}
                    onClick={() => select(selected === part.id ? null : part.id)}
                  >
                    {part.name}
                  </button>
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
