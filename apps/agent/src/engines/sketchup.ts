import type { EngineInstance } from '@complex/protocol'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * SketchUp: единственный движок, где окон бывает много одновременно.
 * Архитекторы держат открытыми по пять-десять моделей, и каждое окно —
 * отдельный процесс со своим портом.
 *
 * Искать их перебором портов не нужно: плагин сам пишет о себе «визитку» и
 * освежает её каждые две секунды. Мы просто читаем каталог.
 */

/** Куда плагин кладёт визитки; путь совпадает с INSTANCES_DIR в плагине. */
const INSTANCES_DIR = join(
  process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'),
  'complex',
  'instances',
)

/**
 * Визитка старше этого срока считается мусором от упавшего процесса.
 *
 * Порог взят из плагина, и причина там же: на Windows проверить живость по PID
 * нельзя — система переиспользует номера процессов, и мёртвый PID отвечает
 * «жив». Возраст визитки такой ошибки не даёт.
 */
const STALE_AFTER_MS = 30_000

interface Card {
  instance_id?: string
  pid?: number
  port?: number
  host?: string
  app_version?: string
  model_title?: string
  model_path?: string
  updated_at?: string
}

/** Читает визитки и возвращает живые окна SketchUp. */
export async function discover(): Promise<EngineInstance[]> {
  let names: string[]
  try {
    names = await readdir(INSTANCES_DIR)
  } catch {
    return [] // каталога нет — плагин ни разу не запускался
  }

  const now = Date.now()
  const found: EngineInstance[] = []

  for (const name of names) {
    if (!name.startsWith('sketchup-') || !name.endsWith('.json')) continue

    let card: Card
    try {
      card = JSON.parse(await readFile(join(INSTANCES_DIR, name), 'utf8')) as Card
    } catch {
      continue // визитка битая или её переписывают прямо сейчас
    }

    if (!card.port || !card.updated_at) continue
    const age = now - Date.parse(card.updated_at)
    if (!Number.isFinite(age) || age > STALE_AFTER_MS) continue

    found.push({
      id: card.instance_id ?? `pid-${card.pid ?? 0}`,
      port: card.port,
      title: card.model_title || 'Без имени',
      path: card.model_path,
      version: card.app_version,
      units: 'mm', // мост переводит миллиметры в дюймы сам
    })
  }

  return found.sort((a, b) => a.port - b.port)
}

/**
 * Вызывает команду моста. Команда приходит в виде «METHOD /путь» — так она
 * записана в реестре инструментов и совпадает с таблицей маршрутов плагина.
 */
export async function call(
  instance: EngineInstance,
  command: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const [method = 'POST', path = '/'] = command.split(' ')
  const url = `http://127.0.0.1:${instance.port}${path}`

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(params),
  })

  const text = await response.text()

  // Мост отдаёт результат обработчика прямо телом ответа, без обёртки, а
  // неудачу — кодом ошибки и телом вида {"error": "..."}. Поэтому успех
  // определяется статусом, а не полем внутри JSON.
  if (!response.ok) {
    let reason = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed.error) reason = parsed.error
    } catch {
      // не JSON — покажем как есть
    }
    throw new Error(`SketchUp: ${reason}`)
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
