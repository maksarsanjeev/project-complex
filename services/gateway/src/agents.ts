import type {
  AgentFrame,
  EngineDescriptor,
  EngineId,
  GatewayFrame,
} from '@complex/protocol'
import type { WebSocket } from 'ws'
import { config } from './config.ts'
import { newId, nowIso } from './db/db.ts'

/**
 * Реестр агентов с рабочих машин.
 *
 * Движки стоят не на сервере, поэтому gateway ничего не выполняет сам: он
 * держит список подключённых агентов и переадресует им вызовы. Соединение
 * всегда исходящее от агента — см. пояснение у AgentFrame в протоколе.
 *
 * Реестр живёт в памяти и это правильно: подключённость — состояние сиюминутное,
 * пережившая перезапуск запись означала бы «движок есть», когда его нет.
 */

const log = (msg: string): void => console.log(`[агенты ${nowIso()}] ${msg}`)

/**
 * Сколько ждём ответа на вызов.
 *
 * Две минуты были абсурдом: человек ждал больше десяти минут, чтобы узнать, что
 * моста нет вовсе — четыре читающих вызова подряд по две минуты каждый. Столько
 * не считается ни один запрос состояния; столько считается только тяжёлая
 * геометрия, и для неё есть отдельный, длинный.
 */
const INVOKE_TIMEOUT_MS = 25_000

/**
 * Долгий таймаут — для вызовов, которые действительно считаются: построение,
 * снимок модели, скрипты. Отличаем по имени команды, а не по флагу у каждого
 * места вызова: забыть флаг легче, чем ошибиться в списке.
 */
const SLOW_TIMEOUT_MS = 300_000
const SLOW = /run_python|run_csharp|execute|snapshot|boolean|fillet|chamfer|geometry|render/i

/**
 * Как часто спрашиваем агента, жив ли он.
 *
 * Понадобилось потому, что сокет умирает молча: gateway продолжал числить
 * агента подключённым, инвентарь показывал движки онлайн, инструменты
 * публиковались — а каждый вызов уходил в никуда и висел до таймаута. Дважды за
 * день это стоило человеку получаса ожидания пустоты.
 */
const HEARTBEAT_MS = 20_000
/** Столько молчания подряд — и соединение считается мёртвым. */
const HEARTBEAT_MISSES = 2

interface PendingInvoke {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Agent {
  id: string
  machine: string
  version: string
  socket: WebSocket
  engines: EngineDescriptor[]
  connectedAt: string
  pending: Map<string, PendingInvoke>
}

const agents = new Map<string, Agent>()

function send(socket: WebSocket, frame: GatewayFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}

/* ────────────────────────── подключение ────────────────────────── */

/**
 * Обслуживает одно соединение агента целиком: от рукопожатия до закрытия.
 * Возвращает управление сразу, дальше работают обработчики сокета.
 */
export function handleAgentSocket(socket: WebSocket): void {
  let agent: Agent | null = null

  socket.on('message', (raw) => {
    let frame: AgentFrame
    try {
      frame = JSON.parse(String(raw)) as AgentFrame
    } catch {
      log('нечитаемый кадр от агента')
      return
    }

    // До приветствия принимается только приветствие.
    if (!agent) {
      if (frame.type !== 'hello') {
        send(socket, { type: 'denied', reason: 'первым кадром должно быть hello' })
        socket.close()
        return
      }

      if (!config.agentToken) {
        log('отказ: AGENT_TOKEN не задан на сервере')
        send(socket, {
          type: 'denied',
          reason: 'сервер не принимает агентов: не задан AGENT_TOKEN',
        })
        socket.close()
        return
      }

      if (frame.token !== config.agentToken) {
        log(`отказ ${frame.machine}: неверный токен`)
        send(socket, { type: 'denied', reason: 'неверный токен' })
        socket.close()
        return
      }

      agent = {
        id: newId('a'),
        machine: frame.machine,
        version: frame.version,
        socket,
        engines: [],
        connectedAt: nowIso(),
        pending: new Map(),
      }
      agents.set(agent.id, agent)
      send(socket, { type: 'welcome', agentId: agent.id })
      log(`подключился ${agent.machine} (агент ${agent.version})`)
      return
    }

    // Переменная agent объявлена через let и обнуляется при отключении,
    // поэтому внутри замыканий её тип снова становится «возможно null».
    // Копия в константу возвращает сужение и заодно защищает от гонки:
    // соединение может закрыться прямо посреди обработки кадра.
    const self = agent

    if (frame.type === 'inventory') {
      self.engines = frame.engines.map((engine) => ({ ...engine, agent: self.machine }))
      const online = self.engines.filter((e) => e.status === 'online')
      log(
        online.length
          ? `${self.machine}: на связи ${online.map((e) => e.id).join(', ')}`
          : `${self.machine}: запущенных движков нет`,
      )
      return
    }

    if (frame.type === 'result') {
      const waiting = self.pending.get(frame.id)
      if (!waiting) return // ответ на вызов, который уже сдался по таймауту
      self.pending.delete(frame.id)
      clearTimeout(waiting.timer)
      if (frame.ok) waiting.resolve(frame.result)
      else waiting.reject(new Error(frame.error))
    }
  })

  const disconnect = (): void => {
    if (!agent) return
    agents.delete(agent.id)
    // Ожидающие вызовы иначе провисят до таймаута, хотя ответить уже некому.
    for (const waiting of agent.pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error('агент отключился, не завершив вызов'))
    }
    agent.pending.clear()
    log(`отключился ${agent.machine}`)
    agent = null
  }

  socket.on('close', disconnect)
  socket.on('error', disconnect)

  /*
    Пульс. Сокет умирает молча — особенно когда машина уходит в сон или сеть
    моргает: TCP этого не замечает, а gateway продолжает числить агента живым и
    отправлять ему вызовы, которые никто не примет.

    Проверяем встроенным ping веб-сокета: он не требует ничего от агента, ответ
    даёт сама библиотека. Два молчания подряд — рвём соединение сами, и тогда
    движки честно становятся offline, а инструменты перестают публиковаться.
    Лучше сказать «SketchUp не запущен», чем молча ждать две минуты на каждом
    вызове.
  */
  let missed = 0
  const pulse = setInterval(() => {
    if (socket.readyState !== socket.OPEN) return
    if (missed >= HEARTBEAT_MISSES) {
      log(`${agent?.machine ?? 'агент'}: молчит ${missed} проверки подряд — отключаю`)
      clearInterval(pulse)
      socket.terminate()
      disconnect()
      return
    }
    missed += 1
    socket.ping()
  }, HEARTBEAT_MS)

  socket.on('pong', () => {
    missed = 0
  })
  socket.on('close', () => clearInterval(pulse))
}

/* ────────────────────────── что сейчас доступно ────────────────────────── */

/** Движки со всех подключённых агентов, в одном списке. */
export function listLiveEngines(): EngineDescriptor[] {
  return [...agents.values()].flatMap((agent) => agent.engines)
}

/** Только запущенные — по ним и составляется список инструментов для модели. */
export function onlineEngines(): EngineDescriptor[] {
  return listLiveEngines().filter((engine) => engine.status === 'online')
}

export function isOnline(engine: EngineId): boolean {
  return onlineEngines().some((e) => e.id === engine)
}

export function agentCount(): number {
  return agents.size
}

/* ────────────────────────── вызов ────────────────────────── */

/**
 * Просит агента выполнить команду в движке. Ищет агента, у которого этот движок
 * запущен; если таких несколько — берёт первого, потому что несколько машин с
 * одним движком пока не сценарий, а вот внятная ошибка при отсутствии — сценарий.
 */
export function invoke(input: {
  engine: EngineId
  instance?: string
  command: string
  params: Record<string, unknown>
}): Promise<unknown> {
  const agent = [...agents.values()].find((a) =>
    a.engines.some((e) => e.id === input.engine && e.status === 'online'),
  )

  if (!agent) {
    const reason = agents.size
      ? `${input.engine} не запущен ни на одной подключённой машине`
      : 'нет ни одного подключённого агента: движки недоступны'
    return Promise.reject(new Error(reason))
  }

  const id = newId('inv')
  return new Promise<unknown>((resolve, reject) => {
    const wait = SLOW.test(input.command) ? SLOW_TIMEOUT_MS : INVOKE_TIMEOUT_MS
    const timer = setTimeout(() => {
      agent.pending.delete(id)
      reject(new Error(`движок ${input.engine} не ответил за ${wait / 1000} с`))
    }, wait)

    agent.pending.set(id, { resolve, reject, timer })
    send(agent.socket, {
      type: 'invoke',
      id,
      engine: input.engine,
      instance: input.instance,
      command: input.command,
      params: input.params,
    })
  })
}
