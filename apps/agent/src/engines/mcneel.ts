/**
 * Официальный мост McNeel RhinoMCP — второй мост к тому же Rhino.
 *
 * Зачем второй, если работает jingcheng. Разница в канале, и она измерена, а не
 * предположена. У jingcheng ответ приходит НАПЕЧАТАННЫМ и приходит ДВАЖДЫ: на
 * снимке в десять мегабайт это двадцать по проводу и разбор, падающий на лишних
 * символах после JSON. У McNeel — обычный MCP поверх HTTP: один конверт
 * `{stdout, error}`, без удвоения, с целой кириллицей. Вдобавок его `run_python`
 * — это Python 3, а не IronPython 2, где `round()` укорачивает значение, но
 * печатает все семнадцать знаков.
 *
 * Чего у него нет: типизированного построения. У jingcheng есть `create_objects`
 * пакетом и `dry_run` у булевых, здесь же вся геометрия идёт скриптом. Поэтому
 * мосты не заменяют друг друга, а дополняют, и оба живут в одном Rhino
 * одновременно — проверено.
 *
 * Порт 10501, а не 10500: команды `mcpstart` и `MCPStart` для Rhino одно и то
 * же, и при двух установленных плагинах второй занимает следующий порт.
 */
import { setTimeout as delay } from 'node:timers/promises'

const HOST = process.env.MCNEEL_HOST ?? '127.0.0.1'
const PORT = Number(process.env.MCNEEL_PORT ?? 10501)
const URL = `http://${HOST}:${PORT}/`

/** Приставка, по которой агент узнаёт команду этого моста. */
export const PREFIX = 'mc:'

let handshake: Promise<void> | null = null
let nextId = 0

async function rpc(method: string, params: unknown, timeoutMs = 180_000): Promise<unknown> {
  const response = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) throw new Error(`McNeel ответил ${response.status}`)

  const frame = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (frame.error) throw new Error(frame.error.message ?? 'McNeel отказал без объяснения')
  return frame.result
}

/**
 * Рукопожатие делается один раз на процесс и запоминается.
 *
 * Повторять его перед каждым вызовом означало бы удваивать число обращений к
 * документу Rhino — а именно частый опрос однажды уронил мост jingcheng.
 */
async function ready(): Promise<void> {
  if (!handshake) {
    handshake = rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'project complex', version: '0.1.0' },
    }, 10_000).then(() => undefined)
    handshake.catch(() => { handshake = null })
  }
  return handshake
}

/** Отвечает ли мост. Ответ и есть признак живого Rhino с этим плагином. */
export async function alive(): Promise<boolean> {
  try {
    await ready()
    return true
  } catch {
    return false
  }
}

export async function call(tool: string, args: Record<string, unknown>): Promise<unknown> {
  await ready()

  const result = (await rpc('tools/call', { name: tool, arguments: args })) as {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>
    isError?: boolean
  }

  const blocks = result?.content ?? []
  const image = blocks.find((b) => b.type === 'image')
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')

  // Скрипты возвращают конверт `{stdout, error}` строкой. Разворачиваем его
  // здесь, чтобы наверху была одна форма ответа, а не две.
  const unwrapped = unwrapScript(text)

  if (image?.data) {
    return { ...(unwrapped ?? { output: text }), base64: image.data, mime: image.mimeType ?? 'image/jpeg' }
  }
  return unwrapped ?? { output: text }
}

function unwrapScript(text: string): Record<string, unknown> | null {
  if (!text.trim().startsWith('{')) return null
  try {
    const box = JSON.parse(text) as { stdout?: unknown; error?: unknown }
    if (typeof box.stdout !== 'string') return null
    if (box.error) throw new Error(String(box.error))

    // Rhino сыплёт в тот же поток свою болтовню про автосохранение. К ответу
    // скрипта она отношения не имеет, и модели её читать незачем.
    const output = box.stdout
      .split('\n')
      .filter((line) => !/^Autosav(e|ing)/.test(line.trim()))
      .join('\n')
      .trim()

    return { output, success: true }
  } catch (error) {
    if (error instanceof Error && !(error instanceof SyntaxError)) throw error
    return null
  }
}

/** Ожидание между попытками — на случай, если Rhino занят пересчётом. */
export async function pause(ms: number): Promise<void> {
  await delay(ms)
}
