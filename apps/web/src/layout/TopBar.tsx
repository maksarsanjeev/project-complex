import { Moon, PanelLeft, PanelRight, Sun } from 'lucide-react'
import { t } from '../i18n'
import { useChat } from '../store/chat'
import { useEngines } from '../store/engine'
import { useLayout } from '../store/layout'
import { useActiveSession } from '../store/session'
import { IconButton, IdChip, Label, StatusMark, type MarkState } from '../ui'
import s from './layout.module.css'

const ENGINE_MARK: Record<string, MarkState> = {
  online: 'ok',
  busy: 'running',
  offline: 'idle',
  error: 'error',
}

export function TopBar() {
  const session = useActiveSession()
  const engines = useEngines((e) => e.engines)
  const bound = useEngines((e) => e.boundEngine)
  const providers = useEngines((e) => e.providers)
  const modelId = useChat((c) => c.modelId)

  const theme = useLayout((l) => l.theme)
  const toggleTheme = useLayout((l) => l.toggleTheme)
  const toggleRail = useLayout((l) => l.toggleRail)
  const toggleTools = useLayout((l) => l.toggleTools)
  const railCollapsed = useLayout((l) => l.railCollapsed)
  const toolsCollapsed = useLayout((l) => l.toolsCollapsed)

  const engine = engines.find((e) => e.id === bound)
  const model = providers.find((p) => p.id === modelId)

  return (
    <header className={s.top}>
      <div className={s.brand}>
        <span className={s.brandMark} aria-hidden />
        <span className={s.brandName}>{t('app.name')}</span>
      </div>

      <span className={s.topDivider} aria-hidden />

      <div className={s.topField}>
        <Label>{t('topbar.project')}</Label>
        <span className={s.topValue}>{session?.project ?? '—'}</span>
      </div>

      {session ? <IdChip>{session.code}</IdChip> : null}
      <span className={s.topValue} title={session?.title}>
        {session?.title ?? ''}
      </span>

      <div className={s.topRight}>
        <div className={s.topField}>
          <Label>{t('topbar.engine')}</Label>
          <StatusMark state={engine ? (ENGINE_MARK[engine.status] ?? 'idle') : 'idle'} />
          <span className={s.topValue}>{engine?.label ?? '—'}</span>
        </div>

        <span className={s.topDivider} aria-hidden />

        <div className={s.topField}>
          <Label>{t('topbar.model')}</Label>
          <span className={s.topValue}>{model?.label ?? '—'}</span>
        </div>

        <span className={s.topDivider} aria-hidden />

        <IconButton active={!railCollapsed} onClick={toggleRail} title={t('rail.sessions')}>
          <PanelLeft size={13} strokeWidth={1} />
        </IconButton>
        <IconButton active={!toolsCollapsed} onClick={toggleTools} title={t('tools.title')}>
          <PanelRight size={13} strokeWidth={1} />
        </IconButton>
        <IconButton onClick={toggleTheme} title={t('topbar.theme')}>
          {theme === 'light' ? <Moon size={13} strokeWidth={1} /> : <Sun size={13} strokeWidth={1} />}
        </IconButton>
      </div>
    </header>
  )
}
