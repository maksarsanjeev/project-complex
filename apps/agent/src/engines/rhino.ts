import type { EngineInstance } from '@complex/protocol'
import { connect, type Socket } from 'node:net'

/**
 * Rhino через сторонний плагин rhinomcp (MIT). Мы его не форкаем — он ставится
 * как обычный плагин и поднимается командой `mcpstart` внутри Rhino.
 *
 * Кадр: 4 байта длины (big-endian) и следом ровно столько байт UTF-8 JSON.
 * Плагин принимает и «голый» JSON без заголовка ради старых клиентов, но мы
 * пишем с заголовком: без него склеить два ответа в одном TCP-пакете нечем.
 */

const PORT = Number(process.env.RHINO_MCP_PORT ?? 1999)
const HOST = '127.0.0.1'
const CONNECT_TIMEOUT_MS = 3_000

/** Одно окно Rhino: несколько документов сразу оно всё равно не держит. */
export async function discover(): Promise<EngineInstance[]> {
  try {
    const summary = (await call('get_document_summary', {})) as {
      unit_system?: string
      units?: string
      name?: string
      path?: string
      version?: string
    }

    return [
      {
        id: 'rhino',
        port: PORT,
        title: summary.name || 'Без имени',
        path: summary.path,
        version: summary.version,
        // Единица документа — то, ради чего мы вообще сюда ходим при опросе:
        // от неё зависит, публиковать ли инструменты Rhino.
        units: summary.unit_system ?? summary.units,
      },
    ]
  } catch {
    return [] // Rhino не запущен или мост не поднят командой mcpstart
  }
}

export function call(command: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: HOST, port: PORT })
    const chunks: Buffer[] = []
    let settled = false

    const done = (error: Error | null, value?: unknown): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS, () =>
      done(new Error(`Rhino не ответил за ${CONNECT_TIMEOUT_MS / 1000} с`)),
    )
    socket.on('error', (error) => done(error))

    socket.on('connect', () => {
      // После установки соединения ждать долго: операция может считаться.
      socket.setTimeout(0)
      const payload = Buffer.from(JSON.stringify({ type: command, params }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32BE(payload.length, 0)
      socket.write(Buffer.concat([header, payload]))
    })

    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      if (buffer.length < 4) return

      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) return // кадр ещё не пришёл целиком

      try {
        const frame = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')) as {
          status?: string
          result?: unknown
          message?: string
        }
        if (frame.status === 'success') done(null, frame.result)
        else done(new Error(frame.message ?? 'Rhino отказал без объяснения'))
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)))
      }
    })

    socket.on('close', () => done(new Error('Rhino закрыл соединение, не ответив')))
  })
}
