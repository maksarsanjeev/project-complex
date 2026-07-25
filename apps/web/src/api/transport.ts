import type { Transport } from '@complex/protocol'
import { MockTransport } from './mock'

/**
 * Единственная точка доступа к бэкенду.
 *
 * Прямые fetch/WebSocket из компонентов запрещены — иначе переезд на реальный
 * gateway превратится в переписывание UI. Когда появится сервер, здесь встанет
 * `new WsTransport(url)`; всё остальное не меняется.
 */
export const transport: Transport = new MockTransport()

/** Показываем в статусбаре, что данные пока ненастоящие. */
export const isMockTransport = transport instanceof MockTransport
