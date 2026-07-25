import { t } from '../i18n'
import { NodeGraph } from '../nodes/NodeGraph'
import { useLayout, type CenterTab } from '../store/layout'
import { Viewport, ViewportToolbar } from '../viewport/Viewport'
import s from './layout.module.css'

const TABS: Array<{ id: CenterTab; key: 'tabs.viewport' | 'tabs.nodes' }> = [
  { id: 'viewport', key: 'tabs.viewport' },
  { id: 'nodes', key: 'tabs.nodes' },
]

/**
 * Обе вкладки держим смонтированными и прячем видимостью: так не теряются
 * позиция камеры и раскладка графа при переключении.
 */
export function CenterStage() {
  const tab = useLayout((l) => l.tab)
  const setTab = useLayout((l) => l.setTab)

  return (
    <div className={s.center}>
      <div className={s.centerHead}>
        <div className={s.tabs}>
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={s.tab}
              data-active={tab === item.id || undefined}
              onClick={() => setTab(item.id)}
            >
              {t(item.key)}
            </button>
          ))}
        </div>
        {tab === 'viewport' ? <ViewportToolbar /> : null}
      </div>

      <div className={s.centerBody}>
        <div className={s.stage} data-hidden={tab !== 'viewport' || undefined}>
          <Viewport />
        </div>
        <div className={s.stage} data-hidden={tab !== 'nodes' || undefined}>
          <NodeGraph />
        </div>
      </div>
    </div>
  )
}
