import type { EngineInstance } from '@complex/protocol'
import { connect, type Socket } from 'node:net'

/**
 * Blender через сторонний аддон blender-mcp (MIT). Ставится как обычный аддон,
 * сокет включается кнопкой на панели BlenderMCP.
 *
 * Кадр проще, чем у Rhino: голый JSON без заголовка длины. Значит границу
 * сообщения приходится угадывать по успешному разбору — аддон отвечает одним
 * объектом на запрос и больше в это соединение не пишет.
 */

const PORT = Number(process.env.BLENDER_PORT ?? 9876)
const HOST = '127.0.0.1'
const CONNECT_TIMEOUT_MS = 3_000

export async function discover(): Promise<EngineInstance[]> {
  try {
    const scene = (await call('get_scene_info', {})) as { name?: string; filepath?: string }
    return [
      {
        id: 'blender',
        port: PORT,
        title: scene.name || 'Без имени',
        path: scene.filepath,
        // Внутренняя единица Blender — метр, и это не настройка документа, а
        // свойство самого приложения. Деление на 1000 зашито в описание
        // инструмента bl_run_python, здесь важно не соврать про единицу.
        units: 'm',
      },
    ]
  } catch {
    return [] // Blender не запущен или сервер аддона выключен
  }
}

export function call(command: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: HOST, port: PORT })
    let received = ''
    let settled = false

    const done = (error: Error | null, value?: unknown): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      done(new Error(`Blender не ответил за ${CONNECT_TIMEOUT_MS / 1000} с`)),
    )
    socket.on('error', (error) => done(error))

    socket.on('connect', () => {
      socket.setTimeout(0)
      socket.write(JSON.stringify({ type: command, params }))
    })

    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8')
      let frame: { status?: string; result?: unknown; message?: string }
      try {
        frame = JSON.parse(received) as typeof frame
      } catch {
        return // ответ пришёл не целиком, ждём остальное
      }
      if (frame.status === 'success') done(null, frame.result)
      else done(new Error(frame.message ?? 'Blender отказал без объяснения'))
    })

    socket.on('close', () => done(new Error('Blender закрыл соединение, не ответив')))
  })
}
