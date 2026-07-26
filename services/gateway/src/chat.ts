import type { ChatEvent, ChatMessage, EngineId, ToolCall } from '@complex/protocol'
import { config } from './config.ts'
import { newId, nowIso } from './db/db.ts'
import { appendMessage } from './db/repo.ts'

/**
 * Живой ответ модели через OpenRouter — один ключ на множество моделей,
 * включая Claude. Поток приходит по SSE и пересылается наружу событиями
 * `token`, так что веб-морда собирает ответ ровно так же, как раньше собирала
 * его от мока: сторона клиента не меняется вовсе.
 *
 * Без ключа сервис не падает, а честно отвечает, что модель не подключена.
 *
 * ВЫХОД В ИНТЕРНЕТ. OpenRouter закрыт Cloudflare для российских адресов —
 * возвращает 403 даже на запрос без ключа. Поэтому на сервере поднят
 * локальный прокси, а запросы уходят через него.
 *
 * Тонкость, которая стоила часа: встроенный в Node fetch НЕ смотрит на
 * HTTPS_PROXY сам по себе. Замерено на живом сервере — с одной этой
 * переменной по-прежнему 403, и только вместе с NODE_USE_ENV_PROXY=1
 * получается 200. Обе переменные заданы в /opt/complex/.env.
 */
export async function* streamAnswer(input: {
  sessionId: string
  text: string
  model?: string
}): AsyncGenerator<ChatEvent> {
  const messageId = newId('m')
  const model = input.model || config.defaultModel

  const message: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    createdAt: nowIso(),
    model,
    streaming: true,
    toolCalls: [],
  }
  yield { type: 'message-start', message }

  let text = ''
  try {
    for await (const chunk of tokens(input.text, model)) {
      text += chunk
      yield { type: 'token', messageId, text: chunk }
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : 'сбой обращения к модели'
    text += `\n\n[${note}]`
    yield { type: 'token', messageId, text: `\n\n[${note}]` }
  }

  // Сообщение сохраняем целиком и один раз: писать каждый токен в базу
  // означало бы сотни записей на один ответ.
  appendMessage(input.sessionId, { ...message, content: text, streaming: false, toolCalls: [] })
  yield { type: 'message-end', messageId }
}

/** Куски текста: от живой модели, либо честное объяснение, что её нет. */
async function* tokens(prompt: string, model: string): AsyncGenerator<string> {
  if (!config.openRouterKey) {
    const note =
      'Модель не подключена: на сервере не задан OPENROUTER_API_KEY. ' +
      'Хранение при этом работает — сообщение сохранено в базе. ' +
      `Запрос был: «${prompt.trim().slice(0, 80)}».`
    for (const piece of note.split(/(\s+)/)) {
      await sleep(12)
      yield piece
    }
    return
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'project complex',
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  })

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter ответил ${response.status}: ${await response.text()}`)
  }

  yield* readServerSentEvents(response.body)
}

/**
 * Разбор потока SSE. Куски приходят по границам сети, а не по границам строк,
 * поэтому хвост неполной строки переносим в следующую итерацию.
 */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>
        }
        const piece = parsed.choices?.[0]?.delta?.content
        if (piece) yield piece
      } catch {
        // Служебные строки без полезной нагрузки просто пропускаем.
      }
    }
  }
}

const SYSTEM_PROMPT = [
  'Ты помогаешь моделировать архитектуру и интерьеры.',
  'Отвечай по-русски, кратко и по делу.',
  'Единица измерения во всём пайплайне — миллиметр.',
  'Прежде чем строить, разложи объект на отдельные части и назови габарит.',
].join(' ')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Заготовка под инструментальные вызовы: движки появятся следующим этапом. */
export type PendingToolCall = ToolCall & { engine: EngineId }
