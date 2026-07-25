import type { Session, SessionStatus } from '@complex/protocol'
import { Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
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

function SessionCard({
  session,
  active,
  onSelect,
}: {
  session: Session
  active: boolean
  onSelect: () => void
}) {
  const rename = useSession((x) => x.renameSession)
  const remove = useSession((x) => x.deleteSession)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(session.title)

  const commit = () => {
    setEditing(false)
    if (draft.trim() && draft !== session.title) void rename(session.id, draft)
    else setDraft(session.title)
  }

  return (
    <div className={s.sessionRow}>
      <button type="button" className={s.session} data-active={active || undefined} onClick={onSelect}>
        <div className={s.sessionTop}>
          <StatusMark state={MARK[session.status]} title={t(STATUS_KEY[session.status])} />
          <IdChip>{session.code}</IdChip>
          <Label>{session.engine}</Label>
        </div>

        {editing ? null : <div className={s.sessionTitle}>{session.title}</div>}

        <div className={s.sessionMeta}>
          <Label tone="ink2">{session.project}</Label>
          <Label>{when(session.updatedAt)}</Label>
          <Label>{session.messageCount} сбщ</Label>
        </div>
      </button>

      {editing ? (
        <div style={{ padding: '0 9px 8px' }}>
          <input
            className={s.renameInput}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setDraft(session.title)
                setEditing(false)
              }
            }}
          />
        </div>
      ) : null}

      <span className={s.sessionActions}>
        <IconButton
          onClick={() => {
            setDraft(session.title)
            setEditing(true)
          }}
          title={t('rail.rename')}
        >
          <Pencil size={11} strokeWidth={1} />
        </IconButton>
        <IconButton onClick={() => void remove(session.id)} title={t('rail.delete')}>
          <Trash2 size={11} strokeWidth={1} />
        </IconButton>
      </span>
    </div>
  )
}

/** Корзина: удаление обратимо, безвозвратное требует отдельного подтверждения. */
function Trash() {
  const trash = useSession((x) => x.trash)
  const restore = useSession((x) => x.restoreSession)
  const purge = useSession((x) => x.purgeSession)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  if (trash.length === 0) return null

  return (
    <div>
      <button type="button" className={s.trashHead} onClick={() => setOpen((v) => !v)}>
        <Trash2 size={11} strokeWidth={1} />
        <Label tone="strong">{t('rail.trash')}</Label>
        <span style={{ marginLeft: 'auto' }}>
          <Label>{trash.length}</Label>
        </span>
      </button>

      {open
        ? trash.map((session) => (
            <div key={session.id} className={s.trashItem}>
              <IdChip>{session.code}</IdChip>
              <span className={s.trashName} title={session.title}>
                {session.title}
              </span>

              {confirming === session.id ? (
                <span className={s.confirm}>
                  <button
                    type="button"
                    className={s.confirmBtn}
                    onClick={() => {
                      setConfirming(null)
                      void purge(session.id)
                    }}
                  >
                    {t('rail.purgeConfirm')}
                  </button>
                  <IconButton onClick={() => setConfirming(null)} title={t('common.cancel')}>
                    <X size={11} strokeWidth={1} />
                  </IconButton>
                </span>
              ) : (
                <span className={s.confirm}>
                  <IconButton onClick={() => void restore(session.id)} title={t('rail.restore')}>
                    <RotateCcw size={11} strokeWidth={1} />
                  </IconButton>
                  <IconButton onClick={() => setConfirming(session.id)} title={t('rail.purge')}>
                    <X size={11} strokeWidth={1} />
                  </IconButton>
                </span>
              )}
            </div>
          ))
        : null}
    </div>
  )
}

export function SessionRail() {
  const sessions = useSession((x) => x.sessions)
  const activeId = useSession((x) => x.activeId)
  const select = useSession((x) => x.select)
  const query = useSession((x) => x.query)
  const setQuery = useSession((x) => x.setQuery)
  const refresh = useSession((x) => x.refresh)
  const createSession = useSession((x) => x.createSession)

  // Поиск идёт через транспорт: он один видит тексты всех переписок.
  useEffect(() => {
    const id = setTimeout(() => void refresh(), 200)
    return () => clearTimeout(id)
  }, [query, refresh])

  return (
    <div className={s.rail}>
      <div className={s.railTop}>
        <div className={s.search}>
          <Search size={12} strokeWidth={1} />
          <input
            className={s.searchInput}
            value={query}
            placeholder={t('rail.search')}
            title={t('rail.searchHint')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <IconButton onClick={() => void createSession()} title={t('rail.newSession')}>
            <Plus size={13} strokeWidth={1} />
          </IconButton>
        </div>

        <div className={s.scroll}>
          {sessions.length === 0 ? (
            <div style={{ padding: 12 }}>
              <Label>{t('rail.empty')}</Label>
            </div>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                active={session.id === activeId}
                onSelect={() => void select(session.id)}
              />
            ))
          )}
          <Trash />
        </div>
      </div>

      <div className={s.railBottom}>
        <Outliner />
      </div>
    </div>
  )
}
