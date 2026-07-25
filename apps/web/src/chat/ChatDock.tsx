import type { ProviderTransport } from '@complex/protocol'
import { ArrowRight, ChevronDown, Square } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { t } from '../i18n'
import { useChat } from '../store/chat'
import { useEngines } from '../store/engine'
import { useLayout } from '../store/layout'
import { useSession } from '../store/session'
import { IconButton, Label, Segmented, type SegmentedOption } from '../ui'
import s from './chat.module.css'
import { Message } from './Message'

const MODES: ReadonlyArray<SegmentedOption<ProviderTransport>> = [
  { value: 'api', label: 'api', title: 'прямой вызов по ключу' },
  { value: 'cli', label: 'cli', title: 'локальный агент подключается сам' },
]

export function ChatDock() {
  const messages = useSession((x) => x.messages)
  const loading = useSession((x) => x.loading)

  const draft = useChat((c) => c.draft)
  const setDraft = useChat((c) => c.setDraft)
  const mode = useChat((c) => c.mode)
  const setMode = useChat((c) => c.setMode)
  const modelId = useChat((c) => c.modelId)
  const setModelId = useChat((c) => c.setModelId)
  const sending = useChat((c) => c.sending)
  const send = useChat((c) => c.send)
  const stop = useChat((c) => c.stop)

  const providers = useEngines((e) => e.providers)
  const toggleChat = useLayout((l) => l.toggleChat)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const available = useMemo(
    () => providers.filter((p) => p.transport === mode),
    [providers, mode],
  )

  // Переключение api/cli не должно оставлять выбранной недоступную модель.
  useEffect(() => {
    if (available.length === 0) return
    if (!available.some((p) => p.id === modelId)) setModelId(available[0].id)
  }, [available, modelId, setModelId])

  // Лента всегда прижата к низу — включая дописывание стриминга.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className={s.root}>
      <header className={s.head}>
        <Label tone="strong">{t('chat.title')}</Label>

        <Segmented options={MODES} value={mode} onChange={setMode} />

        <select
          className={s.select}
          value={modelId}
          disabled={available.length === 0}
          onChange={(e) => setModelId(e.target.value)}
          title={mode === 'api' ? t('chat.modeHint.api') : t('chat.modeHint.cli')}
        >
          {available.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.configured}>
              {p.label}
              {p.configured ? '' : ' — не настроена'}
            </option>
          ))}
        </select>

        <IconButton
          onClick={toggleChat}
          title={t('common.collapse')}
          style={{ marginLeft: 'auto' }}
        >
          <ChevronDown size={13} strokeWidth={1} />
        </IconButton>
      </header>

      <div className={s.list} ref={listRef}>
        {messages.length === 0 && !loading ? (
          <div className={s.empty}>
            <Label>{t('chat.empty')}</Label>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} message={m} />)
        )}
      </div>

      <div className={s.composer}>
        <textarea
          ref={inputRef}
          className={s.input}
          rows={3}
          value={draft}
          placeholder={t('chat.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={s.composerSide}>
          <Label>{t('chat.hint')}</Label>
          {sending ? (
            <button type="button" className={`${s.sendBtn} ${s['sendBtn--stop']}`} onClick={stop}>
              <Square size={10} strokeWidth={1} />
              {t('chat.stop')}
            </button>
          ) : (
            <button
              type="button"
              className={s.sendBtn}
              disabled={draft.trim().length === 0}
              onClick={() => void send()}
            >
              {t('chat.send')}
              <ArrowRight size={12} strokeWidth={1} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
