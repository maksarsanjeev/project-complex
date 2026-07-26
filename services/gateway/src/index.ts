import type { WireRequest, WireResponse } from '@complex/protocol'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { config } from './config.ts'
import { methods, streamMethods } from './handlers.ts'

const log = (msg: string): void => console.log(`[gateway ${new Date().toISOString()}] ${msg}`)

/* ────────────────────────── раздача фронтенда ────────────────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!config.webRoot) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('фронтенд не собран: переменная WEB_ROOT не задана')
    return
  }

  const url = (req.url ?? '/').split('?')[0] ?? '/'
  // normalize сам схлопывает «..», поэтому выход за пределы каталога невозможен.
  const candidate = resolve(join(config.webRoot, normalize(url)))
  const inside = candidate.startsWith(config.webRoot)

  const file =
    inside && existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : join(config.webRoot, 'index.html') // одностраничное приложение: остальное отдаём ему

  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('не найдено')
    return
  }

  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}

/* ────────────────────────── веб-сокет ────────────────────────── */

function send(socket: WebSocket, payload: WireResponse): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload))
}

async function dispatch(socket: WebSocket, request: WireRequest): Promise<void> {
  const params = (request.params ?? {}) as Record<string, unknown>

  try {
    const streaming = streamMethods[request.method]
    if (streaming) {
      for await (const event of streaming(params)) {
        send(socket, { id: request.id, event })
      }
      send(socket, { id: request.id, done: true })
      return
    }

    const method = methods[request.method]
    if (!method) throw new Error(`неизвестный метод: ${request.method}`)

    // Результат может быть undefined — например у методов без ответа.
    send(socket, { id: request.id, result: (await method(params)) ?? null })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`ошибка в ${request.method}: ${message}`)
    send(socket, { id: request.id, error: { message } })
  }
}

/* ────────────────────────── запуск ────────────────────────── */

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, model: Boolean(config.openRouterKey) }))
    return
  }
  serveStatic(req, res)
})

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket) => {
  log('клиент подключился')

  socket.on('message', (raw) => {
    let request: WireRequest
    try {
      request = JSON.parse(String(raw)) as WireRequest
    } catch {
      log('пришёл нечитаемый кадр')
      return
    }
    void dispatch(socket, request)
  })

  socket.on('close', () => log('клиент отключился'))
})

server.listen(config.port, () => {
  log(`слушаю :${config.port}`)
  log(`база: ${config.dbPath}`)
  log(`фронтенд: ${config.webRoot ?? 'не задан'}`)
  log(`модель: ${config.openRouterKey ? config.defaultModel : 'ключ не задан, ответы-заглушки'}`)
})
