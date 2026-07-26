import type {
  ChatAttachment,
  ChatEvent,
  EngineDescriptor,
  EngineId,
  GraphDoc,
  JobEvent,
  JobSpec,
  KnowledgeHit,
  ModelProvider,
  Session,
  SessionState,
  Transport,
  WireRequest,
  WireResponse,
} from '@complex/protocol'

/**
 * Настоящий транспорт: одно веб-сокет-соединение с gateway.
 *
 * Реализует тот же интерфейс, что и MockTransport, поэтому подмена не требует
 * ни одной правки в компонентах — ради этого правила всё и затевалось.
 *
 * Соединение поднимается лениво и переустанавливается само. Вызовы, сделанные
 * до готовности сокета, ждут в очереди, а не падают: интерфейс дёргает
 * транспорт сразу при загрузке страницы, когда сокет ещё открывается.
 */
export class WsTransport implements Transport {
  private socket: WebSocket | null = null
  private counter = 0
  private backoff = 500

  /** Обычные вызовы: id → чем ответить. */
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  /** Потоковые вызовы: id → приёмник событий. */
  private streams = new Map<string, Pump<unknown>>()

  /** Кадры, накопленные пока сокет не открылся. */
  private queue: string[] = []

  constructor(private readonly url: string) {
    this.connect()
  }

  /* ── соединение ─────────────────────────────────────────────── */

  private connect(): void {
    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      this.backoff = 500
      for (const frame of this.queue.splice(0)) socket.send(frame)
    }

    socket.onmessage = (event) => this.receive(String(event.data))

    socket.onclose = () => {
      // Обрываем всё незавершённое: молча висящий вызов хуже честной ошибки.
      const error = new Error('соединение с сервером потеряно')
      for (const [, entry] of this.pending) entry.reject(error)
      this.pending.clear()
      for (const [, pump] of this.streams) pump.fail(error)
      this.streams.clear()

      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 10_000)
    }

    socket.onerror = () => socket.close()
  }

  private receive(raw: string): void {
    let message: WireResponse
    try {
      message = JSON.parse(raw) as WireResponse
    } catch {
      return
    }

    if ('event' in message) {
      this.streams.get(message.id)?.push(message.event)
      return
    }
    if ('done' in message) {
      this.streams.get(message.id)?.close()
      this.streams.delete(message.id)
      return
    }

    const entry = this.pending.get(message.id)
    if (!entry) {
      // Ошибка могла прийти на потоковый вызов.
      if ('error' in message) {
        this.streams.get(message.id)?.fail(new Error(message.error.message))
        this.streams.delete(message.id)
      }
      return
    }
    this.pending.delete(message.id)

    if ('error' in message) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }

  private send(request: WireRequest): void {
    const frame = JSON.stringify(request)
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame)
    else this.queue.push(frame)
  }

  private call<T>(method: string, params?: unknown): Promise<T> {
    const id = String(++this.counter)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.send({ id, method, params })
    })
  }

  private stream<T>(method: string, params?: unknown): AsyncIterable<T> {
    const id = String(++this.counter)
    const pump = new Pump<T>()
    this.streams.set(id, pump as Pump<unknown>)
    this.send({ id, method, params })
    return pump
  }

  /* ── методы протокола ───────────────────────────────────────── */

  listSessions(): Promise<Session[]> {
    return this.call('listSessions')
  }

  listTrash(): Promise<Session[]> {
    return this.call('listTrash')
  }

  openSession(sessionId: string): Promise<SessionState> {
    return this.call('openSession', { sessionId })
  }

  createSession(input: { title: string; project: string; engine: EngineId }): Promise<Session> {
    return this.call('createSession', input)
  }

  renameSession(sessionId: string, title: string): Promise<Session> {
    return this.call('renameSession', { sessionId, title })
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.call('deleteSession', { sessionId })
  }

  restoreSession(sessionId: string): Promise<void> {
    return this.call('restoreSession', { sessionId })
  }

  purgeSession(sessionId: string): Promise<void> {
    return this.call('purgeSession', { sessionId })
  }

  searchSessions(query: string): Promise<Session[]> {
    return this.call('searchSessions', { query })
  }

  sendMessage(input: {
    sessionId: string
    text: string
    attachments?: ChatAttachment[]
    modelId: string
  }): AsyncIterable<ChatEvent> {
    return this.stream<ChatEvent>('sendMessage', input)
  }

  runJob(spec: JobSpec): AsyncIterable<JobEvent> {
    return this.stream<JobEvent>('runJob', spec)
  }

  listEngines(): Promise<EngineDescriptor[]> {
    return this.call('listEngines')
  }

  listProviders(): Promise<ModelProvider[]> {
    return this.call('listProviders')
  }

  searchKnowledge(query: string): Promise<KnowledgeHit[]> {
    return this.call('searchKnowledge', { query })
  }

  saveGraph(sessionId: string, doc: GraphDoc): Promise<void> {
    return this.call('saveGraph', { sessionId, doc })
  }
}

/**
 * Очередь-насос: превращает приходящие события в асинхронный итератор.
 * События могут прийти раньше, чем их начнут читать, поэтому копятся в буфере,
 * а если читатель обогнал отправителя — ждёт на отложенном обещании.
 */
class Pump<T> implements AsyncIterable<T> {
  private buffer: T[] = []
  private waiting: ((r: IteratorResult<T>) => void) | null = null
  private failure: Error | null = null
  private done = false

  push(value: unknown): void {
    const item = value as T
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: item, done: false })
    } else {
      this.buffer.push(item)
    }
  }

  close(): void {
    this.done = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as never, done: true })
    }
  }

  fail(error: Error): void {
    this.failure = error
    this.close()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as T
        continue
      }
      if (this.failure) throw this.failure
      if (this.done) return

      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiting = resolve
      })
      if (next.done) {
        if (this.failure) throw this.failure
        return
      }
      yield next.value
    }
  }
}
