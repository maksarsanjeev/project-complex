/**
 * Честный счёт расхода: приведённые токены и деньги.
 *
 * Зачем понадобилось. Сырая сумма ввода обманывает: за один ход модель
 * перечитывает контекст на каждом круге инструментов, и миллион токенов в логе
 * означает тридцать тысяч новых плюс девятьсот семьдесят тысяч повторов,
 * которые стоят десятую часть. Человек видит миллион и решает, что работа
 * дорогая, хотя она дешёвая.
 *
 * Поэтому считаем две величины.
 *
 * ПРИВЕДЁННЫЕ ТОКЕНЫ — всё сведённое к одной единице по весу стоимости. Число
 * остаётся в токенах, значит его можно сравнивать между прогонами и по нему
 * складывается чутьё: простая деталь — единицы тысяч, сложная сборка — сотня.
 *
 * ДЕНЬГИ — то же самое в рублях смысла для тех, кто в токенах не считает.
 * Нужны обе: одна для работы, другая для разговора с людьми со стороны.
 *
 * На подписке деньги не списываются, и это надо помечать словом «справочно», а
 * не убирать цифру: сравнивать ходы между собой она позволяет.
 */

/**
 * Во сколько раз токен дороже обычного ввода.
 *
 * Чтение из кэша — десятая часть, и именно оно раздувает сырые суммы. Запись в
 * кэш дороже ввода: провайдер один раз платит за укладку. Ответ дороже всего.
 */
export const WEIGHTS = {
  input: 1,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const

/** Цены за миллион токенов. Сверены со списком провайдера. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'anthropic/claude-opus-5': { input: 5, output: 25 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
}

const FALLBACK = { input: 5, output: 25 }

export interface RawSpend {
  /** Новый ввод — то, что модель видит впервые. */
  input: number
  /** Записано в кэш. */
  cacheWrite: number
  /** Прочитано из кэша: дёшево, но именно оно раздувает сырые суммы. */
  cacheRead: number
  /** Ответ модели. */
  output: number
}

export interface Spend {
  /** Одна цифра для сравнения ходов между собой. */
  effective: number
  /** Она же в деньгах — для тех, кто в токенах не считает. */
  cost: number
}

/**
 * Свести расход к одной цифре и к деньгам.
 *
 * Ответ приводится к вводу по отношению цен, а не по выдуманному множителю:
 * у Opus это впятеро, у Haiku тоже впятеро, но зависимость лучше брать из
 * тарифа, чтобы при его смене ничего не пересчитывать руками.
 */
export function measure(raw: RawSpend, model: string): Spend {
  const price = PRICES[model] ?? FALLBACK
  const outputWeight = price.output / price.input

  const effective =
    raw.input * WEIGHTS.input +
    raw.cacheWrite * WEIGHTS.cacheWrite +
    raw.cacheRead * WEIGHTS.cacheRead +
    raw.output * outputWeight

  const cost =
    ((raw.input * WEIGHTS.input +
      raw.cacheWrite * WEIGHTS.cacheWrite +
      raw.cacheRead * WEIGHTS.cacheRead) /
      1_000_000) *
      price.input +
    (raw.output / 1_000_000) * price.output

  return { effective: Math.round(effective), cost }
}

/** Строка для лога: сырое рядом с приведённым, чтобы разница была видна. */
export function describe(raw: RawSpend, model: string): string {
  const { effective, cost } = measure(raw, model)
  const total = raw.input + raw.cacheWrite + raw.cacheRead

  return (
    `приведено ${effective.toLocaleString('ru-RU')} т ` +
    `($${cost.toFixed(4)} справочно) | ` +
    `сырьём ${total.toLocaleString('ru-RU')} ввод ` +
    `(нового ${raw.input.toLocaleString('ru-RU')}, из кэша ${raw.cacheRead.toLocaleString('ru-RU')}), ` +
    `ответ ${raw.output.toLocaleString('ru-RU')}`
  )
}
