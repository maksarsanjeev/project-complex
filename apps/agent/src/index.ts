import type {
  AgentFrame,
  EngineDescriptor,
  EngineId,
  EngineInstance,
  GatewayFrame,
} from '@complex/protocol'
import { hostname } from 'node:os'
import WebSocket from 'ws'
import * as blender from './engines/blender.ts'
import * as rhino from './engines/rhino.ts'
import * as sketchup from './engines/sketchup.ts'

/**
 * Агент project complex — мостик между сервером и движками на рабочей машине.
 *
 * Соединение всегда ИСХОДЯЩЕЕ. На этой машине не открывается ни одного
 * входящего порта, мосты движков остаются на 127.0.0.1, файрвол не трогается.
 * Иначе SketchUp с его execute_ruby и Rhino с выполнением C# оказались бы
 * доступны любому в локальной сети.
 *
 * Запуск:
 *   complex-agent --gateway ws://192.168.10.94:8787/agent --token СЕКРЕТ
 * либо через переменные COMPLEX_GATEWAY и COMPLEX_TOKEN.
 */

const VERSION = '0.1.0'

/* ────────────────────────── настройки ────────────────────────── */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const gatewayUrl = arg('gateway') ?? process.env.COMPLEX_GATEWAY ?? ''
const token = arg('token') ?? process.env.COMPLEX_TOKEN ?? ''
const machine = arg('machine') ?? process.env.COMPLEX_MACHINE ?? hostname()

if (!gatewayUrl || !token) {
  console.error(
    'Не задан адрес сервера или токен.\n' +
      '  complex-agent --gateway ws://ХОСТ:8787/agent --token СЕКРЕТ\n' +
      'Токен должен совпадать с AGENT_TOKEN на сервере.',
  )
  process.exit(1)
}

const log = (msg: string): void => console.log(`[агент ${new Date().toISOString()}] ${msg}`)

/* ────────────────────────── опрос движков ────────────────────────── */

/** Как часто заглядываем, что запущено. */
const POLL_MS = 5_000

const ENGINE_META: Record<EngineId, { label: string; port: number; exports: EngineDescriptor['exports'] }> = {
  sketchup: { label: 'SketchUp', port: 8080, exports: ['skp', 'obj', 'fbx', 'dae', 'stl'] },
  rhino: {
    label: 'Rhinoceros',
    port: 1999,
    exports: ['3dm', 'obj', 'stl', 'step', 'glb', 'fbx', 'dae'],
  },
  blender: {
    label: 'Blender',
    port: 9876,
    exports: ['glb', 'gltf', 'fbx', 'obj', 'stl', 'usd'],
  },
}

let inventory: EngineDescriptor[] = []

async function poll(): Promise<EngineDescriptor[]> {
  // Опрашиваем разом: Rhino и Blender отвечают через сокет, и ждать их
  // по очереди значило бы складывать таймауты.
  const [su, rh, bl] = await Promise.all([
    sketchup.discover().catch(() => []),
    rhino.discover().catch(() => []),
    blender.discover().catch(() => []),
  ])

  const build = (id: EngineId, instances: EngineInstance[]): EngineDescriptor => ({
    id,
    label: ENGINE_META[id].label,
    status: instances.length ? 'online' : 'offline',
    port: instances[0]?.port ?? ENGINE_META[id].port,
    version: instances[0]?.version,
    exports: ENGINE_META[id].exports,
    lastSeen: instances.length ? new Date().toISOString() : undefined,
    instances,
  })

  return [build('sketchup', su), build('rhino', rh), build('blender', bl)]
}

/** Сравнение по содержимому: слать инвентарь каждые пять секунд незачем. */
function digest(engines: EngineDescriptor[]): string {
  return engines
    .map((e) => `${e.id}:${e.status}:${(e.instances ?? []).map((i) => `${i.id}@${i.port}:${i.title}:${i.units}`).join(',')}`)
    .join('|')
}

/* ────────────────────────── выполнение вызовов ────────────────────────── */

async function execute(frame: Extract<GatewayFrame, { type: 'invoke' }>): Promise<unknown> {
  const engine = inventory.find((e) => e.id === frame.engine)
  const instances = engine?.instances ?? []

  if (!instances.length) throw new Error(`${frame.engine} не запущен на машине ${machine}`)

  if (frame.engine === 'rhino') return rhino.call(frame.command, frame.params)
  if (frame.engine === 'blender') return blender.call(frame.command, frame.params)

  // SketchUp: окон бывает несколько, и тогда выбор обязателен. Молча взять
  // первое — значит однажды построить стену в чужом проекте.
  const listing = (): string => instances.map((i) => `${i.title} (${i.id})`).join('; ')

  if (frame.instance) {
    const chosen = instances.find((i) => i.id === frame.instance || i.title === frame.instance)
    if (!chosen) throw new Error(`окно «${frame.instance}» не найдено. Открыты: ${listing()}`)
    return sketchup.call(chosen, frame.command, frame.params)
  }

  // Окно не названо — берём отмеченное кнопкой «Окно для ИИ».
  const active = sketchup.activeInstance(instances)
  if (active) return sketchup.call(active, frame.command, frame.params)

  if (instances.length > 1) {
    throw new Error(
      'открыто несколько окон SketchUp, и ни одно не отмечено для работы. ' +
        'Пусть пользователь нажмёт в нужном окне «Расширения → MCP Server → Окно для ИИ», ' +
        `либо укажи параметр instance. Открыты: ${listing()}`,
    )
  }

  const only = instances[0]
  if (!only) throw new Error('окно SketchUp исчезло между опросом и вызовом')
  return sketchup.call(only, frame.command, frame.params)
}

/* ────────────────────────── соединение ────────────────────────── */

/** Пауза перед следующей попыткой: растёт, но не больше полуминуты. */
let backoff = 1_000
let socket: WebSocket | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function send(frame: AgentFrame): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

function startPolling(): void {
  let lastDigest = ''

  const tick = async (): Promise<void> => {
    inventory = await poll()
    const current = digest(inventory)
    // Шлём только при изменениях: сервер и так помнит последнее состояние.
    if (current !== lastDigest) {
      lastDigest = current
      send({ type: 'inventory', engines: inventory })
      const online = inventory.filter((e) => e.status === 'online')
      log(
        online.length
          ? `движки: ${online.map((e) => `${e.label} (${(e.instances ?? []).length})`).join(', ')}`
          : 'запущенных движков нет',
      )
    }
  }

  void tick()
  pollTimer = setInterval(() => void tick(), POLL_MS)
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

function connect(): void {
  log(`подключаюсь к ${gatewayUrl}`)
  socket = new WebSocket(gatewayUrl)

  socket.on('open', () => {
    backoff = 1_000
    send({ type: 'hello', token, machine, version: VERSION })
  })

  socket.on('message', (raw) => {
    let frame: GatewayFrame
    try {
      frame = JSON.parse(String(raw)) as GatewayFrame
    } catch {
      return
    }

    if (frame.type === 'welcome') {
      log(`сервер принял, я ${frame.agentId}`)
      startPolling()
      return
    }

    if (frame.type === 'denied') {
      // Отказ — не сетевой сбой: перезапрашивать бессмысленно, пока человек
      // не поправит токен. Выходим с ошибкой, чтобы это было видно.
      console.error(`Сервер отказал: ${frame.reason}`)
      process.exit(1)
    }

    if (frame.type === 'invoke') {
      const started = Date.now()
      execute(frame)
        .then((result) =>
          send({ type: 'result', id: frame.id, ok: true, result, durationMs: Date.now() - started }),
        )
        .catch((error: unknown) =>
          send({
            type: 'result',
            id: frame.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - started,
          }),
        )
    }
  })

  const retry = (why: string): void => {
    stopPolling()
    socket = null
    log(`${why}; следующая попытка через ${Math.round(backoff / 1000)} с`)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 30_000)
  }

  socket.on('close', () => retry('соединение закрыто'))
  socket.on('error', (error) => retry(`сбой связи: ${error.message}`))
}

connect()
