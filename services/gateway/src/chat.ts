import type { ChatEvent, ChatMessage, ToolCall } from '@complex/protocol'
import { config } from './config.ts'
import { newId, nowIso } from './db/db.ts'
import { appendMessage, listMessages } from './db/repo.ts'
import { availableTools, engineSummary, runTool, toWireTools } from './tools/registry.ts'

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

/* ────────────────────────── формат обмена с моделью ────────────────────────── */

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** Что вернул один круг общения с моделью. */
interface Round {
  text: string
  calls: WireToolCall[]
}

/* ────────────────────────── история ────────────────────────── */

/** Сколько последних сообщений и знаков подаём модели. */
const HISTORY_LIMIT = 30
const HISTORY_CHARS = 12_000

/**
 * Собирает историю переписки для модели.
 *
 * ВАЖНО: сообщение пользователя уже лежит в базе — его сохраняет sendMessage
 * ДО вызова streamAnswer. Поэтому текст запроса сюда отдельно добавлять не
 * нужно, иначе модель увидит вопрос дважды и начнёт отвечать на него как на
 * повтор.
 *
 * Прошлые вызовы инструментов сворачиваются в короткую пометку. Восстанавливать
 * из базы настоящие tool_call_id незачем: модели достаточно знать, что было
 * сделано и чем кончилось, а полная точность нужна только внутри текущего хода.
 */
function buildHistory(sessionId: string): WireMessage[] {
  const all = listMessages(sessionId)
  const recent = all.slice(-HISTORY_LIMIT)

  const messages: WireMessage[] = []
  let budget = HISTORY_CHARS

  // Идём с конца: если бюджета не хватит, обрезать надо старое, а не свежее.
  for (let i = recent.length - 1; i >= 0; i--) {
    const message = recent[i]
    if (!message) continue

    const notes = (message.toolCalls ?? [])
      .map((call) => `[${call.name} → ${call.status === 'ok' ? 'выполнено' : 'ошибка'}]`)
      .join(' ')
    const content = [message.content, notes].filter(Boolean).join('\n')
    if (!content.trim()) continue

    budget -= content.length
    if (budget < 0) break

    messages.unshift({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    })
  }

  return messages
}

/* ────────────────────────── ход разговора ────────────────────────── */

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
  const toolCalls: ToolCall[] = []

  if (!config.openRouterKey) {
    const note =
      'Модель не подключена: на сервере не задан OPENROUTER_API_KEY. ' +
      'Хранение при этом работает — сообщение сохранено в базе. ' +
      `Запрос был: «${input.text.trim().slice(0, 80)}».`
    for (const piece of note.split(/(\s+)/)) {
      await sleep(12)
      text += piece
      yield { type: 'token', messageId, text: piece }
    }
    appendMessage(input.sessionId, { ...message, content: text, streaming: false, toolCalls: [] })
    yield { type: 'message-end', messageId }
    return
  }

  const tools = availableTools()
  const conversation: WireMessage[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${engineSummary()}` },
    ...buildHistory(input.sessionId),
  ]

  try {
    // Круг = один запрос к модели. Пока она просит инструменты — продолжаем.
    for (let round = 0; round < config.maxToolRounds; round++) {
      const result: Round = { text: '', calls: [] }

      for await (const piece of streamRound(conversation, model, tools)) {
        if (piece.kind === 'text') {
          result.text += piece.text
          text += piece.text
          yield { type: 'token', messageId, text: piece.text }
        } else {
          result.calls = piece.calls
        }
      }

      if (!result.calls.length) break

      conversation.push({
        role: 'assistant',
        content: result.text || null,
        tool_calls: result.calls,
      })

      for (const call of result.calls) {
        const args = parseArguments(call.function.arguments)

        const started: ToolCall = {
          id: call.id,
          name: call.function.name,
          engine: 'sketchup',
          status: 'running',
          code: call.function.arguments,
        }
        yield { type: 'tool-call', messageId, toolCall: started }

        const outcome = await runTool(call.function.name, args)

        const finished: ToolCall = {
          ...started,
          engine: outcome.engine,
          status: outcome.ok ? 'ok' : 'error',
          code: outcome.code,
          result: outcome.content,
          durationMs: outcome.durationMs,
        }
        toolCalls.push(finished)
        yield { type: 'tool-update', messageId, toolCall: finished }

        conversation.push({
          role: 'tool',
          tool_call_id: call.id,
          content: outcome.content,
        })
      }

      // Круги кончились, а модель всё просит инструменты — говорим прямо.
      if (round === config.maxToolRounds - 1) {
        const note = `\n\n[остановился: за ${config.maxToolRounds} кругов работа не сошлась]`
        text += note
        yield { type: 'token', messageId, text: note }
      }
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : 'сбой обращения к модели'
    text += `\n\n[${note}]`
    yield { type: 'token', messageId, text: `\n\n[${note}]` }
  }

  // Сообщение сохраняем целиком и один раз: писать каждый токен в базу
  // означало бы сотни записей на один ответ. Вызовы инструментов сохраняем
  // вместе с ним — иначе после перезагрузки страницы от работы движка не
  // осталось бы и следа.
  appendMessage(input.sessionId, { ...message, content: text, streaming: false, toolCalls })
  yield { type: 'message-end', messageId }
}

/** Аргументы приходят строкой и вполне могут оказаться битыми. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/* ────────────────────────── один запрос к модели ────────────────────────── */

type RoundPiece = { kind: 'text'; text: string } | { kind: 'calls'; calls: WireToolCall[] }

async function* streamRound(
  messages: WireMessage[],
  model: string,
  tools: ReturnType<typeof availableTools>,
): AsyncGenerator<RoundPiece> {
  const body: Record<string, unknown> = { model, stream: true, messages }
  // Пустой список инструментов отправлять нельзя: часть провайдеров считает
  // это ошибкой. Нет движков — нет и поля.
  if (tools.length) body.tools = toWireTools(tools)

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'project complex',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter ответил ${response.status}: ${await response.text()}`)
  }

  yield* readServerSentEvents(response.body)
}

/**
 * Разбор потока SSE. Куски приходят по границам сети, а не по границам строк,
 * поэтому хвост неполной строки переносим в следующую итерацию.
 *
 * Вызовы инструментов приезжают по частям: имя функции обычно целиком в первой
 * дельте, а аргументы склеиваются из кусков. Связка между кусками — поле
 * `index`, а НЕ `id`: идентификатор приходит только с первым куском.
 */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RoundPiece> {
  const decoder = new TextDecoder()
  let buffer = ''
  const calls = new Map<number, WireToolCall>()

  const finish = (): RoundPiece => ({
    kind: 'calls',
    calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
  })

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        yield finish()
        return
      }

      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
        }

        const delta = parsed.choices?.[0]?.delta
        if (!delta) continue

        if (delta.content) yield { kind: 'text', text: delta.content }

        for (const part of delta.tool_calls ?? []) {
          const existing = calls.get(part.index) ?? {
            id: part.id ?? `call_${part.index}`,
            type: 'function' as const,
            function: { name: '', arguments: '' },
          }
          if (part.id) existing.id = part.id
          if (part.function?.name) existing.function.name = part.function.name
          if (part.function?.arguments) existing.function.arguments += part.function.arguments
          calls.set(part.index, existing)
        }
      } catch {
        // Служебные строки без полезной нагрузки просто пропускаем.
      }
    }
  }

  // Поток кончился без [DONE] — такое бывает при обрыве соединения.
  yield finish()
}

const SYSTEM_PROMPT = [
  'Ты помогаешь моделировать архитектуру и интерьеры.',
  'Отвечай по-русски, кратко и по делу.',
  'Единица измерения во всём пайплайне — миллиметр: все размеры в инструментах задавай в мм.',
  'Прежде чем строить, разложи объект на отдельные части и назови габарит.',
  'Слои называй по материалу — кирпич, стекло, бетон, дерево, — а не по назначению.',
  'Прежде чем править существующую геометрию, посмотри на неё соответствующим инструментом:',
  'идентификаторы объектов нельзя угадать, их получают из списка.',
  'Никогда не сообщай, что построил что-то, если вызов инструмента не прошёл.',
].join(' ')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
