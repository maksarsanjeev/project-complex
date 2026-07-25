import type { ChatMessage, ToolCall } from '@complex/protocol'
import { useState } from 'react'
import { t } from '../i18n'
import { Label, StatusMark, cx, type MarkState } from '../ui'
import s from './chat.module.css'

const ROLE_LABEL = {
  user: 'chat.role.user',
  assistant: 'chat.role.assistant',
  tool: 'chat.role.tool',
  system: 'chat.role.system',
} as const

const TOOL_MARK: Record<ToolCall['status'], MarkState> = {
  pending: 'idle',
  running: 'running',
  ok: 'ok',
  error: 'error',
}

function ToolCallBlock({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false)

  return (
    <div className={s.tool}>
      <button type="button" className={s.toolHead} onClick={() => setOpen((v) => !v)}>
        <StatusMark state={TOOL_MARK[call.status]} />
        <span className={s.toolName}>{call.name}</span>
        <span className={s.toolMeta}>
          <span>{call.engine}</span>
          {call.durationMs != null ? <span>{(call.durationMs / 1000).toFixed(1)} с</span> : null}
        </span>
      </button>

      {open ? (
        <div className={s.toolBody}>
          {call.code ? (
            <>
              <Label>{t('chat.toolCode')}</Label>
              <pre className={s.code}>{call.code}</pre>
            </>
          ) : null}
          {call.result ? (
            <>
              <Label>{t('chat.toolResult')}</Label>
              <pre className={s.code}>{call.result}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const time = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

export function Message({ message }: { message: ChatMessage }) {
  return (
    <article className={s.msg}>
      <div className={s.gutter}>
        <span className={cx(s.roleChip, message.role === 'user' && s['roleChip--user'])}>
          {message.role === 'assistant' && message.model
            ? message.model
            : t(ROLE_LABEL[message.role])}
        </span>
        <span className={s.time}>{time(message.createdAt)}</span>
      </div>

      <div className={s.body}>
        <div className={cx(s.text, message.role === 'system' && s['text--system'])}>
          {message.content}
          {message.streaming ? <span className={s.caret} /> : null}
        </div>

        {message.attachments?.length ? (
          <div className={s.attachments}>
            {message.attachments.map((a) => (
              <span key={a.id} className={s.attachment} title={a.name}>
                {a.name}
              </span>
            ))}
          </div>
        ) : null}

        {message.toolCalls?.length ? (
          <div className={s.tools}>
            {message.toolCalls.map((call) => (
              <ToolCallBlock key={call.id} call={call} />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}
