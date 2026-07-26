import type { Transport } from '@complex/protocol'
import { MockTransport } from './mock'
import { WsTransport } from './ws'

/**
 * Единственная точка доступа к бэкенду.
 *
 * Прямые fetch/WebSocket из компонентов запрещены — благодаря этому переезд с
 * мока на настоящий gateway свёлся к выбору реализации в этом файле и не
 * потребовал правок ни в одном компоненте.
 */

/** Адрес gateway. По умолчанию тот же хост — контейнер раздаёт и морду, и API. */
function gatewayUrl(): string {
  const configured = import.meta.env.VITE_GATEWAY_URL
  if (configured) return configured
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws`
}

/** Мок остаётся под рукой: с ним можно править интерфейс без запущенного сервера. */
const useMock = import.meta.env.VITE_USE_MOCK === '1'

export const transport: Transport = useMock ? new MockTransport() : new WsTransport(gatewayUrl())

/** Статусбар показывает, откуда идут данные. */
export const isMockTransport = useMock
