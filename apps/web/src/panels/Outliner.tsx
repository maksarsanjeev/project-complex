import { Eye, EyeOff, Lock, Unlock } from 'lucide-react'
import { t } from '../i18n'
import { useSession } from '../store/session'
import { IconButton, Label } from '../ui'
import s from './panels.module.css'

/**
 * Дерево сцены. Слои названы по МАТЕРИАЛУ — так материал назначается одним
 * кликом, и так устроены рабочие файлы проекта.
 */
export function Outliner() {
  const scene = useSession((x) => x.scene)
  const toggleVisible = useSession((x) => x.toggleNodeVisible)
  const toggleLocked = useSession((x) => x.toggleNodeLocked)

  const total = scene
    .filter((n) => n.kind === 'layer')
    .reduce((sum, n) => sum + (n.triangles ?? 0), 0)

  return (
    <>
      <div className={s.search}>
        <Label tone="strong">{t('rail.outliner')}</Label>
        <span style={{ marginLeft: 'auto' }}>
          <Label>{total.toLocaleString('ru-RU')} тр</Label>
        </span>
      </div>

      <div className={s.scroll}>
        {scene.map((node) => {
          const isLayer = node.kind === 'layer'
          return (
            <div
              key={node.id}
              className={s.node}
              data-layer={isLayer || undefined}
              data-visible={node.visible ? 'true' : 'false'}
            >
              <span className={s.nodeIndent} style={{ width: isLayer ? 8 : 22 }} />
              <span className={s.nodeName} title={node.name}>
                {node.name}
              </span>
              {node.triangles ? (
                <span className={s.nodeTris}>{node.triangles.toLocaleString('ru-RU')}</span>
              ) : null}
              <span className={s.nodeBtns}>
                <IconButton
                  onClick={() => toggleVisible(node.id)}
                  title={node.visible ? t('common.collapse') : t('common.expand')}
                >
                  {node.visible ? (
                    <Eye size={12} strokeWidth={1} />
                  ) : (
                    <EyeOff size={12} strokeWidth={1} />
                  )}
                </IconButton>
                <IconButton onClick={() => toggleLocked(node.id)}>
                  {node.locked ? (
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
