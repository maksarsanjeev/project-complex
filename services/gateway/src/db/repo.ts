import type {
  ChatMessage,
  EngineId,
  GraphDoc,
  Session,
  SessionState,
  ToolCall,
} from '@complex/protocol'
import { db, newId, nowIso } from './db.ts'

/* ────────────────────────── разбор строк ────────────────────────── */

type Row = Record<string, unknown>

const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => (v == null ? 0 : Number(v))

function toSession(row: Row): Session {
  const session: Session = {
    id: str(row.id),
    code: str(row.code),
    title: str(row.title),
    project: str(row.project),
    engine: str(row.engine) as EngineId,
    status: str(row.status) as Session['status'],
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    messageCount: num(row.message_count),
  }
  if (row.deleted_at) session.deletedAt = str(row.deleted_at)
  return session
}

function toToolCall(row: Row): ToolCall {
  const call: ToolCall = {
    id: str(row.id),
    name: str(row.name),
    engine: str(row.engine) as EngineId,
    status: str(row.status) as ToolCall['status'],
  }
  if (row.code != null) call.code = str(row.code)
  if (row.result != null) call.result = str(row.result)
  if (row.duration_ms != null) call.durationMs = num(row.duration_ms)
  return call
}

/* ────────────────────────── сессии ────────────────────────── */

// Счёт сообщений берём подзапросом, а не отдельным полем: денормализованный
// счётчик рано или поздно разъезжается с реальностью.
const SESSION_COLUMNS = `
  s.*, (SELECT count(*) FROM messages m WHERE m.session_id = s.id) AS message_count
`

export function listSessions(userId: string): Session[] {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       WHERE s.user_id = ? AND s.deleted_at IS NULL
       ORDER BY s.updated_at DESC`,
    )
    .all(userId)
    .map((r) => toSession(r as Row))
}

export function listTrash(userId: string): Session[] {
  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       WHERE s.user_id = ? AND s.deleted_at IS NOT NULL
       ORDER BY s.deleted_at DESC`,
    )
    .all(userId)
    .map((r) => toSession(r as Row))
}

export function getSession(userId: string, sessionId: string): Session | null {
  const row = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.user_id = ? AND s.id = ?`)
    .get(userId, sessionId)
  return row ? toSession(row as Row) : null
}

/**
 * Поиск идёт по заголовку, проекту, коду И содержимому переписки — включая
 * код инструментальных вызовов. Именно поэтому он живёт на сервере: у клиента
 * чужих диалогов просто нет.
 */
export function searchSessions(userId: string, query: string): Session[] {
  const q = query.trim().toLowerCase()
  if (!q) return listSessions(userId)
  const like = `%${q}%`

  return db
    .prepare(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       WHERE s.user_id = ? AND s.deleted_at IS NULL AND (
            lower(s.title)   LIKE ?
         OR lower(s.project) LIKE ?
         OR lower(s.code)    LIKE ?
         OR EXISTS (SELECT 1 FROM messages m
                    WHERE m.session_id = s.id AND lower(m.content) LIKE ?)
         OR EXISTS (SELECT 1 FROM messages m
                    JOIN tool_calls t ON t.message_id = m.id
                    WHERE m.session_id = s.id AND (
                         lower(t.name)   LIKE ?
                      OR lower(coalesce(t.code, ''))   LIKE ?
                      OR lower(coalesce(t.result, '')) LIKE ?))
       )
       ORDER BY s.updated_at DESC`,
    )
    .all(userId, like, like, like, like, like, like, like)
    .map((r) => toSession(r as Row))
}

export function createSession(
  userId: string,
  input: { title: string; project: string; engine: EngineId },
): Session {
  const now = nowIso()
  const id = newId('s')

  // Номер для чипа берём как максимум существующего плюс один, чтобы коды не
  // повторялись после удаления сессий.
  const row = db
    .prepare(
      `SELECT max(CAST(replace(code, 'SES-', '') AS INTEGER)) AS n
       FROM sessions WHERE user_id = ?`,
    )
    .get(userId) as Row | undefined
  const code = `SES-${String(num(row?.n) + 1).padStart(3, '0')}`

  db.prepare(
    `INSERT INTO sessions (id, user_id, code, title, project, engine, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(id, userId, code, input.title, input.project, input.engine, now, now)

  db.prepare('INSERT INTO graphs (session_id, doc, updated_at) VALUES (?, ?, ?)').run(
    id,
    JSON.stringify({ nodes: [], edges: [] }),
    now,
  )

  return getSession(userId, id)!
}

export function renameSession(userId: string, sessionId: string, title: string): Session | null {
  const clean = title.trim()
  if (!clean) return getSession(userId, sessionId)
  db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
    clean,
    nowIso(),
    userId,
    sessionId,
  )
  return getSession(userId, sessionId)
}

/** В корзину — удаление обратимо. Безвозвратно удаляет только purge. */
export function deleteSession(userId: string, sessionId: string): void {
  db.prepare('UPDATE sessions SET deleted_at = ? WHERE user_id = ? AND id = ?').run(
    nowIso(),
    userId,
    sessionId,
  )
}

export function restoreSession(userId: string, sessionId: string): void {
  db.prepare(
    'UPDATE sessions SET deleted_at = NULL, updated_at = ? WHERE user_id = ? AND id = ?',
  ).run(nowIso(), userId, sessionId)
}

export function purgeSession(userId: string, sessionId: string): void {
  // Сообщения, вызовы и граф уйдут каскадом — за это отвечает foreign_keys.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').run(userId, sessionId)
}

/* ────────────────────────── переписка ────────────────────────── */

export function listMessages(sessionId: string): ChatMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as Row[]

  const calls = db
    .prepare(
      `SELECT t.* FROM tool_calls t
       JOIN messages m ON m.id = t.message_id
       WHERE m.session_id = ? ORDER BY t.seq`,
    )
    .all(sessionId) as Row[]

  const byMessage = new Map<string, ToolCall[]>()
  for (const row of calls) {
    const key = str(row.message_id)
    byMessage.set(key, [...(byMessage.get(key) ?? []), toToolCall(row)])
  }

  return rows.map((row) => {
    const message: ChatMessage = {
      id: str(row.id),
      role: str(row.role) as ChatMessage['role'],
      content: str(row.content),
      createdAt: str(row.created_at),
    }
    if (row.model != null) message.model = str(row.model)
    const toolCalls = byMessage.get(message.id)
    if (toolCalls?.length) message.toolCalls = toolCalls
    return message
  })
}

function nextSeq(sessionId: string): number {
  const row = db
    .prepare('SELECT coalesce(max(seq), 0) AS n FROM messages WHERE session_id = ?')
    .get(sessionId) as Row
  return num(row.n) + 1
}

export function appendMessage(sessionId: string, message: ChatMessage): ChatMessage {
  const seq = nextSeq(sessionId)
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, model, created_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    sessionId,
    message.role,
    message.content,
    message.model ?? null,
    message.createdAt,
    seq,
  )

  const insertCall = db.prepare(
    `INSERT INTO tool_calls (id, message_id, name, engine, status, code, result, duration_ms, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  ;(message.toolCalls ?? []).forEach((call, index) => {
    insertCall.run(
      call.id,
      message.id,
      call.name,
      call.engine,
      call.status,
      call.code ?? null,
      call.result ?? null,
      call.durationMs ?? null,
      index,
    )
  })

  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), sessionId)
  return message
}

/* ────────────────────────── граф ────────────────────────── */

const EMPTY_GRAPH: GraphDoc = { nodes: [], edges: [] }

export function getGraph(sessionId: string): GraphDoc {
  const row = db.prepare('SELECT doc FROM graphs WHERE session_id = ?').get(sessionId) as
    | Row
    | undefined
  if (!row) return structuredClone(EMPTY_GRAPH)
  try {
    return JSON.parse(str(row.doc)) as GraphDoc
  } catch {
    // Битый документ не должен ронять открытие сессии.
    return structuredClone(EMPTY_GRAPH)
  }
}

export function saveGraph(sessionId: string, doc: GraphDoc): void {
  db.prepare(
    `INSERT INTO graphs (session_id, doc, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
  ).run(sessionId, JSON.stringify(doc), nowIso())
}

export function openSession(userId: string, sessionId: string): SessionState | null {
  const session = getSession(userId, sessionId)
  if (!session) return null
  return {
    session,
    messages: listMessages(sessionId),
    scene: [],
    graph: getGraph(sessionId),
  }
}
