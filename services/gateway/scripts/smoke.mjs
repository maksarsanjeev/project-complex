// Сквозная проверка gateway: подключаемся веб-сокетом и гоняем реальные вызовы.
import { WebSocket } from 'ws'

const url = process.env.GW_URL || 'ws://127.0.0.1:8787/ws'
const socket = new WebSocket(url)

let counter = 0
const pending = new Map()

socket.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  const entry = pending.get(msg.id)
  if (!entry) return
  if ('event' in msg) return entry.events.push(msg.event)
  if ('error' in msg) { pending.delete(msg.id); return entry.reject(new Error(msg.error.message)) }
  if ('done' in msg) { pending.delete(msg.id); return entry.resolve(entry.events) }
  pending.delete(msg.id)
  entry.resolve(msg.result)
})

function call(method, params) {
  const id = String(++counter)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, events: [] })
    socket.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`таймаут ${method}`)) }
    }, 30000)
  })
}

const ok = (label, value) => console.log(`  ${label}: ${value}`)

socket.on('open', async () => {
  try {
    console.log('=== сессии ===')
    let sessions = await call('listSessions', {})
    ok('было сессий', sessions.length)

    const created = await call('createSession', {
      title: 'Проверка хранения', project: 'Стенд', engine: 'rhino',
    })
    ok('создана', `${created.code} «${created.title}»`)

    console.log('=== переписка со стримингом ===')
    const events = await call('sendMessage', {
      sessionId: created.id,
      text: 'Собери стеллаж 2400 мм высотой, пять полок',
      modelId: 'claude-sonnet-api',
    })
    const tokens = events.filter((e) => e.type === 'token')
    ok('событий всего', events.length)
    ok('токенов', tokens.length)
    ok('ответ', tokens.map((t) => t.text).join('').slice(0, 120) + '…')

    console.log('=== сохранение графа ===')
    await call('saveGraph', {
      sessionId: created.id,
      doc: { nodes: [{ id: 'n1', code: 'ND-01', kind: 'input.prompt', title: 'Промпт',
                       position: { x: 10, y: 20 }, inputs: [], outputs: [],
                       params: { text: 'стеллаж' } }], edges: [] },
    })

    console.log('=== перечитываем всё заново ===')
    const state = await call('openSession', { sessionId: created.id })
    ok('сообщений в базе', state.messages.length)
    ok('роли', state.messages.map((m) => m.role).join(' → '))
    ok('узлов в графе', state.graph.nodes.length)
    ok('параметр узла', JSON.stringify(state.graph.nodes[0]?.params))

    console.log('=== поиск по тексту переписки ===')
    const found = await call('searchSessions', { query: 'стеллаж' })
    ok('найдено по слову из сообщения', found.map((s) => s.code).join(', ') || 'ничего')
    const none = await call('searchSessions', { query: 'абракадабра' })
    ok('по несуществующему', none.length)

    console.log('=== корзина ===')
    await call('deleteSession', { sessionId: created.id })
    ok('в живых после удаления', (await call('listSessions', {})).length)
    ok('в корзине', (await call('listTrash', {})).length)
    await call('restoreSession', { sessionId: created.id })
    ok('после возврата', (await call('listSessions', {})).length)
    await call('purgeSession', { sessionId: created.id })
    ok('после безвозвратного удаления', (await call('listSessions', {})).length)

    console.log('\nВСЁ ПРОШЛО')
    socket.close()
    process.exit(0)
  } catch (error) {
    console.error('ПРОВАЛ:', error.message)
    socket.close()
    process.exit(1)
  }
})

socket.on('error', (e) => { console.error('сокет:', e.message); process.exit(1) })
