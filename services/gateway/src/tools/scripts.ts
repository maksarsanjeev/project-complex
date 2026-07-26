import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Доменные скрипты для Rhino живут в engines/rhino/scripts настоящими файлами
 * .py, а не строками внутри TypeScript. Так их можно открыть, прочитать,
 * подсветить и поправить как обычный код — а он там нетривиальный.
 *
 * Скрипт отправляется в Rhino целиком при каждом вызове. Могло бы показаться
 * расточительным, но альтернатива — «установить» его в сессию Rhino и надеяться,
 * что состояние доживёт до следующего вызова. Не доживёт: пользователь
 * перезапустит Rhino, а мы будем звать функцию, которой уже нет.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Каталог со скриптами. Ищем по нескольким адресам, потому что запускаемся
 * по-разному: из исходников (services/gateway/src/tools) и из сборки
 * в контейнере (/app/dist/tools, скрипты рядом в /app/engines).
 */
function locate(): string {
  const candidates = [
    process.env.ENGINES_DIR,
    resolve(HERE, '../../../../engines'), // из исходников
    resolve(HERE, '../../engines'), // из dist внутри контейнера
    resolve(process.cwd(), 'engines'),
  ].filter((path): path is string => Boolean(path))

  for (const path of candidates) {
    if (existsSync(join(path, 'rhino', 'scripts'))) return path
  }
  return candidates[1] ?? ''
}

const ENGINES_DIR = locate()

const cache = new Map<string, string>()

export function rhinoScript(name: string): string {
  const cached = cache.get(name)
  if (cached) return cached

  const path = join(ENGINES_DIR, 'rhino', 'scripts', name)
  const text = readFileSync(path, 'utf8')
  cache.set(name, text)
  return text
}

/**
 * Значение в виде литерала Python. JSON почти совпадает с синтаксисом Python,
 * но ровно в трёх местах расходится, и все три встречаются здесь постоянно:
 * null против None, true против True, false против False.
 */
export function pyLiteral(value: unknown): string {
  if (value === undefined || value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None'
  return JSON.stringify(value)
}

/** Подставляет значения вместо меток вида __NAME__. */
export function fill(script: string, values: Record<string, unknown>): string {
  let result = script
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`__${key}__`, pyLiteral(value))
  }
  return result
}
