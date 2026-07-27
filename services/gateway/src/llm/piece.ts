import type { ToolOutcome } from '../tools/registry.ts'

/**
 * Общий язык двух провайдеров модели.
 *
 * Зачем он нужен. У OpenRouter цикл инструментов крутим мы сами: спросили —
 * получили список вызовов — выполнили — спросили снова. У Agent SDK цикл
 * крутит сам SDK, а мы только подаём инструменты и слушаем, что происходит.
 * Снаружи, в переписке и в веб-морде, разницы быть не должно: там и там
 * человек видит текст, блоки вызовов и счётчик расхода.
 *
 * Поэтому оба провайдера говорят кусками одного вида, а `streamAnswer`
 * превращает их в события протокола и пишет сообщение в базу. Провайдер не
 * знает ни про базу, ни про `ChatEvent` — только про эти пять случаев.
 */
export type LlmPiece =
  /** Кусок текста ответа, как он печатается. */
  | { kind: 'text'; text: string }
  /** Инструмент пошёл в работу. */
  | { kind: 'tool-start'; id: string; name: string; args: Record<string, unknown> }
  /** Инструмент отработал — с результатом или с ошибкой. */
  | { kind: 'tool-done'; id: string; name: string; outcome: ToolOutcome }
  /** Модель задала вопрос и ждёт ответа: ход на этом кончается. */
  | { kind: 'ask'; question: string; options?: string[] }
  /** Сколько потрачено. Может прийти несколько раз — складываем. */
  | { kind: 'usage'; usage: Usage }

/**
 * Расход по обращению к модели.
 *
 * `cached` — сколько токенов ввода взято из кэша вместо пересчёта. Именно эта
 * цифра показывает, работает ли кэширование подсказки: без него она всегда 0.
 */
export interface Usage {
  prompt: number
  completion: number
  cached: number
  cost?: number
}

/**
 * Очередь между обработчиком инструмента и потоком ответа.
 *
 * Понадобилась из-за Agent SDK: там инструменты исполняются внутри обработчика,
 * который вызывает не наш код, и «выдать наружу событие» изнутри него нельзя —
 * генератор в это время ждёт следующего сообщения SDK. Обработчик кладёт кусок
 * сюда, генератор забирает. Порядок сохраняется сам собой: обработчик работает
 * внутри хода модели, между её текстовыми кусками.
 */
export class PieceQueue {
  private items: LlmPiece[] = []
  private waiting: ((piece: LlmPiece | null) => void)[] = []
  private closed = false
  private failure: unknown = null

  push(piece: LlmPiece): void {
    const waiter = this.waiting.shift()
    if (waiter) waiter(piece)
    else this.items.push(piece)
  }

  /** Закрыть очередь. Ошибку запоминаем, чтобы бросить её на стороне читателя. */
  close(error?: unknown): void {
    if (error) this.failure = error
    this.closed = true
    for (const waiter of this.waiting.splice(0)) waiter(null)
  }

  async *drain(): AsyncGenerator<LlmPiece> {
    for (;;) {
      const item = this.items.shift()
      if (item) {
        yield item
        continue
      }
      if (this.closed) break
      const next = await new Promise<LlmPiece | null>((resolve) => this.waiting.push(resolve))
      if (next) yield next
    }
    // Бросаем после того, как отдали всё накопленное: если модель успела
    // построить половину и упала, эта половина должна дойти до человека.
    if (this.failure) throw this.failure
  }
}
