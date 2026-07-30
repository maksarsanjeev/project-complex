/**
 * Мост к Blender: blender-ai-mcp поверх streamable HTTP.
 *
 * Устроен иначе, чем оба предыдущих, и разница существенная.
 *
 * СЕССИЯ ОБЯЗАТЕЛЬНА. Транспорт выдаёт идентификатор заголовком
 * `mcp-session-id` при рукопожатии и ждёт его в каждом следующем запросе. Без
 * него сервер отвечает вежливо и бесполезно: `tools/list` возвращает НОЛЬ
 * инструментов вместо ста восьмидесяти семи, и выглядит это как пустой мост, а
 * не как ошибка. Проверено на живом сервере.
 *
 * ИНСТРУМЕНТОВ МНОГО. Сто восемьдесят семь против тридцати у McNeel: арматура,
 * запекание карт, коллекции, кривые, материалы с узлами, анализ топологии.
 * Вываливать их все в подсказку нельзя — описания оплачиваются на каждом
 * круге, — поэтому наверх уходит отобранный набор, а не всё подряд.
 *
 * Сервер живёт отдельным процессом на машине пользователя и говорит с самим
 * Blender по своему RPC на 8765. Нам этот слой не виден: мы обращаемся только
 * к HTTP.
 */

const HOST = process.env.BLENDER_MCP_HOST ?? '127.0.0.1'
const PORT = Number(process.env.BLENDER_MCP_PORT ?? 8000)
const URL = `http://${HOST}:${PORT}/mcp`

/** Приставка, по которой агент узнаёт команду этого моста. */
export const PREFIX = 'bl:'

/**
 * Очередь обращений: к мосту ходим строго по одному.
 *
 * Причина не в осторожности, а в наблюдении. При параллельных вызовах сессия
 * разъезжается: приходят таймауты, WinError 10038 «операция на объекте, не
 * являющемся сокетом», и — самое опасное — ответ на один запрос с ошибкой от
 * другого. Модель это заметила сама и отказалась работать, совершенно
 * правильно: доверять чтению сцены после такого нельзя.
 *
 * Тот же урок мы уже получали от моста Rhino. Чужие мосты рассчитаны на
 * последовательные вызовы, и наша задача — не разгонять их, а выстроить.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job)
  // Хвост очереди не должен ломаться от чужой ошибки: гасим её здесь, а
  // настоящему вызову она уходит своим путём.
  queue = next.catch(() => undefined)
  return next
}

let session: string | null = null
let handshake: Promise<void> | null = null
let nextId = 0

async function post(body: unknown, expectAnswer = true): Promise<unknown> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (session) headers['mcp-session-id'] = session

  const response = await fetch(URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })

  // Идентификатор сессии приходит один раз, при рукопожатии. Забыть его —
  // значит потерять весь список инструментов.
  const issued = response.headers.get('mcp-session-id')
  if (issued) session = issued

  if (!response.ok) throw new Error(`Blender ответил ${response.status}`)
  if (!expectAnswer) return null

  // Ответ бывает и обычным JSON, и потоком событий: берём строку данных.
  const text = await response.text()
  const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text
  const frame = JSON.parse(line.replace(/^data:\s*/, '')) as {
    id?: number
    result?: unknown
    error?: { message?: string }
  }
  if (frame.error) throw new Error(frame.error.message ?? 'Blender отказал без объяснения')

  // Сверяем, тому ли запросу пришёл ответ. Без этой проверки перепутанные
  // ответы выглядят как правдоподобные данные — и модель строит по чужому
  // состоянию сцены, ничего не подозревая.
  const asked = (body as { id?: number }).id
  if (asked !== undefined && frame.id !== undefined && frame.id !== asked) {
    throw new Error(`Blender ответил не на тот запрос: ждали ${asked}, пришёл ${frame.id}`)
  }
  return frame.result
}

/**
 * Рукопожатие делается один раз на процесс.
 *
 * После него обязательно уведомление `initialized` — без него сервер считает
 * сессию незавершённой и инструментов не отдаёт.
 */
async function ready(): Promise<void> {
  if (!handshake) {
    handshake = (async () => {
      session = null
      await post({
        jsonrpc: '2.0',
        id: ++nextId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'project complex', version: '0.1.0' },
        },
      })
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
    })()
    handshake.catch(() => {
      handshake = null
    })
  }
  return handshake
}

/** Отвечает ли мост. Ответ и есть признак живого Blender с аддоном. */
export async function alive(): Promise<boolean> {
  try {
    await ready()
    return true
  } catch {
    handshake = null
    return false
  }
}

export async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return serialize(() => callOne(tool, args))
}

async function callOne(tool: string, args: Record<string, unknown>): Promise<unknown> {
  await ready()

  const result = (await post({
    jsonrpc: '2.0',
    id: ++nextId,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  })) as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
    structuredContent?: unknown
    isError?: boolean
  }

  const blocks = result?.content ?? []
  const image = blocks.find((b) => b.type === 'image')
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')

  // Структурированный ответ предпочтительнее текста: у этого моста он есть, и
  // разбирать печать, как у Rhino, не приходится.
  const payload = result?.structuredContent ?? parseJson(text) ?? { output: text }

  if (image?.data) {
    return { ...(payload as object), base64: image.data, mime: image.mimeType ?? 'image/png' }
  }
  return payload
}

function parseJson(text: string): unknown {
  if (!text.trim().startsWith('{')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
