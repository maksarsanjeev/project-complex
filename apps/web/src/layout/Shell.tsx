import { ChevronUp, PanelLeft, PanelRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Group, Panel as Pane, Separator, useDefaultLayout } from 'react-resizable-panels'
import { ChatDock } from '../chat/ChatDock'
import { t } from '../i18n'
import { SessionRail } from '../panels/SessionRail'
import { ToolsPanel } from '../panels/ToolsPanel'
import { useLayout } from '../store/layout'
import { IconButton, Label } from '../ui'
import { CenterStage } from './CenterStage'
import s from './layout.module.css'
import { StatusBar } from './StatusBar'
import { TopBar } from './TopBar'

/** Свёрнутая боковая панель — узкая полоса с вертикальной подписью. */
function CollapsedSide({
  label,
  right = false,
  onExpand,
  icon,
}: {
  label: string
  right?: boolean
  onExpand: () => void
  icon: ReactNode
}) {
  return (
    <div className={`${s.collapsedV} ${right ? s.collapsedVRight : ''}`}>
      <IconButton onClick={onExpand} title={t('common.expand')}>
        {icon}
      </IconButton>
      <span className={s.vertical}>{label}</span>
    </div>
  )
}

/**
 * Вертикальная группа: сцена сверху, чат снизу.
 * Компонент монтируется по ключу конфигурации, поэтому сохранённая раскладка
 * читается заново под текущий набор панелей.
 */
function CenterGroup({ withChat }: { withChat: boolean }) {
  const panelIds = withChat ? ['stage', 'chat'] : ['stage']
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `complex.center.${panelIds.join('-')}`,
    panelIds,
    storage: window.localStorage,
  })

  return (
    <Group
      orientation="vertical"
      className={s.group}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <Pane id="stage" className={s.pane} defaultSize="68" minSize="28">
        <CenterStage />
      </Pane>
      {withChat ? (
        <>
          <Separator className={s.handleH} />
          <Pane id="chat" className={s.pane} defaultSize="32" minSize="14">
            <ChatDock />
          </Pane>
        </>
      ) : null}
    </Group>
  )
}

/** Горизонтальная группа: рельс — центр — инструменты. */
function MainGroup({ withRail, withTools }: { withRail: boolean; withTools: boolean }) {
  const toggleRail = useLayout((l) => l.toggleRail)
  const toggleTools = useLayout((l) => l.toggleTools)
  const toggleChat = useLayout((l) => l.toggleChat)
  const chatCollapsed = useLayout((l) => l.chatCollapsed)

  const panelIds = [withRail && 'rail', 'center', withTools && 'tools'].filter(
    Boolean,
  ) as string[]

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `complex.main.${panelIds.join('-')}`,
    panelIds,
    storage: window.localStorage,
  })

  return (
    <Group
      orientation="horizontal"
      className={s.group}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      {withRail ? (
        <>
          <Pane id="rail" className={s.pane} defaultSize="17" minSize="12" maxSize="32">
            <SessionRail />
          </Pane>
          <Separator className={s.handleV} />
        </>
      ) : null}

      <Pane id="center" className={s.pane} minSize="30">
        <div className={s.centerWrap}>
          {withRail ? null : (
            <CollapsedSide
              label={t('rail.sessions')}
              onExpand={toggleRail}
              icon={<PanelLeft size={13} strokeWidth={1} />}
            />
          )}

          <div className={s.centerColumn}>
            <div className={s.centerFill}>
              <CenterGroup withChat={!chatCollapsed} />
            </div>
            {chatCollapsed ? (
              <div className={s.collapsedH}>
                <Label tone="strong">{t('chat.title')}</Label>
                <IconButton
                  onClick={toggleChat}
                  title={t('common.expand')}
                  style={{ marginLeft: 'auto' }}
                >
                  <ChevronUp size={13} strokeWidth={1} />
                </IconButton>
              </div>
            ) : null}
          </div>

          {withTools ? null : (
            <CollapsedSide
              label={t('tools.title')}
              right
              onExpand={toggleTools}
              icon={<PanelRight size={13} strokeWidth={1} />}
            />
          )}
        </div>
      </Pane>

      {withTools ? (
        <>
          <Separator className={s.handleV} />
          <Pane id="tools" className={s.pane} defaultSize="20" minSize="14" maxSize="34">
            <ToolsPanel />
          </Pane>
        </>
      ) : null}
    </Group>
  )
}

export function Shell() {
  const railCollapsed = useLayout((l) => l.railCollapsed)
  const toolsCollapsed = useLayout((l) => l.toolsCollapsed)

  return (
    <div className={s.shell}>
      <TopBar />
      <div className={s.main}>
        <MainGroup
          key={`${railCollapsed ? 0 : 1}${toolsCollapsed ? 0 : 1}`}
          withRail={!railCollapsed}
          withTools={!toolsCollapsed}
        />
      </div>
      <StatusBar />
    </div>
  )
}
