import type { Session, SessionStatus } from '@complex/protocol'
import { Plus, Search } from 'lucide-react'
import { useMemo } from 'react'
import { t } from '../i18n'
import { useSession } from '../store/session'
import { IconButton, IdChip, Label, StatusMark, type MarkState } from '../ui'
import { Outliner } from './Outliner'
import s from './panels.module.css'

const MARK: Record<SessionStatus, MarkState> = {
  idle: 'idle',
  running: 'running',
  error: 'error',
  done: 'ok',
}

const STATUS_KEY = {
  idle: 'status.idle',
  running: 'status.running',
  error: 'status.error',
  done: 'status.done',
} as const

function when(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ч`
  return `${Math.round(hours / 24)} сут`
}

function SessionCard({ session, active, onSelect }: {
  session: Session
  active: boolean
  onSelect: () => void
}) {
  return (
    <button type="button" className={s.session} data-active={active || undefined} onClick={onSelect}>
      <div className={s.sessionTop}>
        <StatusMark state={MARK[session.status]} title={t(STATUS_KEY[session.status])} />
        <IdChip>{session.code}</IdChip>
        <Label>{session.engine}</Label>
      </div>
      <div className={s.sessionTitle}>{session.title}</div>
      <div className={s.sessionMeta}>
        <Label tone="ink2">{session.project}</Label>
        <Label>{when(session.updatedAt)}</Label>
        <Label>{session.messageCount} сбщ</Label>
      </div>
    </button>
  )
}

export function SessionRail() {
  const sessions = useSession((x) => x.sessions)
  const activeId = useSession((x) => x.activeId)
  const select = useSession((x) => x.select)
  const query = useSession((x) => x.query)
  const setQuery = useSession((x) => x.setQuery)
  const createSession = useSession((x) => x.createSession)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter(
      (x) =>
        x.title.toLowerCase().includes(q) ||
        x.project.toLowerCase().includes(q) ||
        x.code.toLowerCase().includes(q),
    )
  }, [sessions, query])

  return (
    <div className={s.rail}>
      <div className={s.railTop}>
        <div className={s.search}>
          <Search size={12} strokeWidth={1} />
          <input
            className={s.searchInput}
            value={query}
            placeholder={t('rail.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <IconButton onClick={() => void createSession()} title={t('rail.newSession')}>
            <Plus size={13} strokeWidth={1} />
          </IconButton>
        </div>

        <div className={s.scroll}>
          {filtered.length === 0 ? (
            <div style={{ padding: 12 }}>
              <Label>{t('rail.empty')}</Label>
            </div>
          ) : (
            filtered.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                active={session.id === activeId}
                onSelect={() => void select(session.id)}
              />
            ))
          )}
        </div>
      </div>

      <div className={s.railBottom}>
        <Outliner />
      </div>
    </div>
  )
}
