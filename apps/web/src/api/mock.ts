import type {
  ChatAttachment,
  ChatEvent,
  ChatMessage,
  EngineDescriptor,
  EngineId,
  GraphDoc,
  Job,
  JobEvent,
  JobSpec,
  KnowledgeHit,
  ModelProvider,
  SelectionRef,
  Session,
  SessionState,
  Transport,
} from '@complex/protocol'

import * as fx from './fixtures'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let counter = 0
const nextId = (prefix: string): string =>
  `${prefix}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** Версию держим в ключе: при несовместимой смене формата старый слепок просто игнорируется. */
const STORAGE_KEY = 'complex.mock.v1'

interface Snapshot {
  sessions: Session[]
  messages: Record<string, ChatMessage[]>
  graphs: Record<string, GraphDoc>
}

function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Snapshot
    if (!Array.isArray(parsed.sessions)) return null
    return parsed
  } catch {
    // Битый или недоступный слепок — не повод падать, просто начинаем с фикстур.
    return null
  }
}

/**
 * Заглушка бэкенда: те же сигнатуры и тот же стриминг, что будут у gateway.
 *
 * Состояние переживает перезагрузку страницы через localStorage — это временная
 * мера на время этапа 1. Настоящее хранение появится на стороне gateway, и
 * тогда весь этот класс заменится на WsTransport без правок в компонентах.
 */
export class MockTransport implements Transport {
  private sessions: Session[]
  private messagesBySession: Map<string, ChatMessage[]>
  private graphBySession: Map<string, GraphDoc>

  constructor() {
    const snapshot = loadSnapshot()
    if (snapshot) {
      this.sessions = snapshot.sessions
      this.messagesBySession = new Map(Object.entries(snapshot.messages))
      this.graphBySession = new Map(Object.entries(snapshot.graphs))
      return
    }

    this.sessions = fx.sessions.map((s) => ({ ...s }))
    this.messagesBySession = new Map()
    this.graphBySession = new Map()
    // Диалогом наполняем только «живую» сессию, остальные начинают пустыми.
    for (const session of this.sessions) {
      this.messagesBySession.set(
        session.id,
        session.id === 's-014' ? fx.messages.map((m) => ({ ...m })) : [],
      )
      this.graphBySession.set(session.id, structuredClone(fx.graph))
    }
    this.persist()
  }

  private persist(): void {
    try {
      const snapshot: Snapshot = {
        sessions: this.sessions,
        messages: Object.fromEntries(this.messagesBySession),
        graphs: Object.fromEntries(this.graphBySession),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // Переполнение квоты не должно ронять интерфейс.
    }
  }

  private find(sessionId: string): Session | undefined {
    return this.sessions.find((s) => s.id === sessionId)
  }

  private touch(session: Session): void {
    session.updatedAt = new Date().toISOString()
    session.messageCount = this.messagesBySession.get(session.id)?.length ?? 0
  }

  /* ── сессии ───────────────────────────────────────────────── */

  async listSessions(): Promise<Session[]> {
    await sleep(90)
    return this.sessions.filter((s) => !s.deletedAt).map((s) => ({ ...s }))
  }

  async listTrash(): Promise<Session[]> {
    await sleep(60)
    return this.sessions.filter((s) => s.deletedAt).map((s) => ({ ...s }))
  }

  async openSession(sessionId: string): Promise<SessionState> {
    await sleep(140)
    const session = this.find(sessionId) ?? this.sessions.find((s) => !s.deletedAt)
    if (!session) throw new Error('нет ни одной сессии')

    const messages = this.messagesBySession.get(session.id) ?? []
    this.messagesBySession.set(session.id, messages)

    const graph = this.graphBySession.get(session.id) ?? structuredClone(fx.graph)
    this.graphBySession.set(session.id, graph)

    return {
      session: { ...session },
      messages: messages.map((m) => ({ ...m })),
      scene: [],
      graph: structuredClone(graph),
    }
  }

  async createSession(input: {
    title: string
    project: string
    engine: EngineId
  }): Promise<Session> {
    await sleep(110)
    const now = new Date().toISOString()
    const numbers = this.sessions
      .map((s) => Number.parseInt(s.code.replace(/\D/g, ''), 10))
      .filter((n) => Number.isFinite(n))
    const next = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1

    const session: Session = {
      id: nextId('s'),
      code: `SES-${String(next).padStart(3, '0')}`,
      title: input.title,
      project: input.project,
      engine: input.engine,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
    this.sessions = [session, ...this.sessions]
    this.messagesBySession.set(session.id, [])
    this.graphBySession.set(session.id, { nodes: [], edges: [] })
    this.persist()
    return { ...session }
  }

  async renameSession(sessionId: string, title: string): Promise<Session> {
    await sleep(70)
    const session = this.find(sessionId)
    if (!session) throw new Error('сессия не найдена')
    session.title = title.trim() || session.title
    session.updatedAt = new Date().toISOString()
    this.persist()
    return { ...session }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await sleep(70)
    const session = this.find(sessionId)
    if (!session) return
    session.deletedAt = new Date().toISOString()
    this.persist()
  }

  async restoreSession(sessionId: string): Promise<void> {
    await sleep(70)
    const session = this.find(sessionId)
    if (!session) return
    delete session.deletedAt
    session.updatedAt = new Date().toISOString()
    this.persist()
  }

  async purgeSession(sessionId: string): Promise<void> {
    await sleep(70)
    this.sessions = this.sessions.filter((s) => s.id !== sessionId)
    this.messagesBySession.delete(sessionId)
    this.graphBySession.delete(sessionId)
    this.persist()
  }

  async searchSessions(query: string): Promise<Session[]> {
    await sleep(90)
    const q = query.trim().toLowerCase()
    const live = this.sessions.filter((s) => !s.deletedAt)
    if (!q) return live.map((s) => ({ ...s }))

    return live
      .filter((s) => {
        if (
          s.title.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q) ||
          s.code.toLowerCase().includes(q)
        ) {
          return true
        }
        // Содержимое переписки: и текст сообщений, и код инструментальных вызовов.
        return (this.messagesBySession.get(s.id) ?? []).some(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            (m.toolCalls ?? []).some(
              (tc) =>
                tc.name.toLowerCase().includes(q) ||
                (tc.code ?? '').toLowerCase().includes(q) ||
                (tc.result ?? '').toLowerCase().includes(q),
            ),
        )
      })
      .map((s) => ({ ...s }))
  }

  /* ── диалог ───────────────────────────────────────────────── */

  async *sendMessage(input: {
    sessionId: string
    text: string
    attachments?: ChatAttachment[]
    modelId: string
    selection?: SelectionRef[]
  }): AsyncIterable<ChatEvent> {
    const provider = fx.providers.find((p) => p.id === input.modelId)
    const session = this.find(input.sessionId)
    const history = this.messagesBySession.get(input.sessionId) ?? []
    this.messagesBySession.set(input.sessionId, history)

    // Сообщение пользователя стор уже показал — здесь фиксируем его в хранилище.
    history.push({
      id: nextId('u'),
      role: 'user',
      content: input.text,
      createdAt: new Date().toISOString(),
      attachments: input.attachments,
    })

    const messageId = nextId('m')
    const message: ChatMessage = {
      id: messageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      model: provider?.model ?? 'claude-opus-5',
      streaming: true,
      toolCalls: [],
    }

    await sleep(240)
    yield { type: 'message-start', message }

    const reply = draftReply(input.text)
    let text = ''
    for (const chunk of chunkify(reply)) {
      await sleep(18 + Math.random() * 26)
      text += chunk
      yield { type: 'token', messageId, text: chunk }
    }

    const call = {
      id: nextId('tc'),
      name: 'rhino_exec',
      engine: 'rhino' as EngineId,
      status: 'running' as const,
      code: buildSnippet(input.text),
    }
    yield { type: 'tool-call', messageId, toolCall: call }

    await sleep(900)
    const done = {
      ...call,
      status: 'ok' as const,
      result: 'геометрия построена, замкнутых тел 100%',
      durationMs: 900 + Math.round(Math.random() * 3200),
    }
    yield { type: 'tool-update', messageId, toolCall: done }

    await sleep(180)
    history.push({ ...message, content: text, streaming: false, toolCalls: [done] })
    if (session) this.touch(session)
    this.persist()

    yield { type: 'message-end', messageId }
  }

  /* ── задачи и справочники ─────────────────────────────────── */

  async *runJob(spec: JobSpec): AsyncIterable<JobEvent> {
    const job: Job = {
      id: nextId('j'),
      code: `JOB-${String(200 + Math.floor(Math.random() * 800))}`,
      spec,
      status: 'running',
      progress: 0,
      startedAt: new Date().toISOString(),
    }
    yield { type: 'job-start', job }

    const stages = ['разбор графа', 'построение', 'проверка дисциплины', 'выгрузка']
    for (let i = 0; i < stages.length; i++) {
      await sleep(420 + Math.random() * 500)
      yield {
        type: 'job-progress',
        jobId: job.id,
        progress: (i + 1) / stages.length,
        message: stages[i],
      }
    }

    yield {
      type: 'job-end',
      job: { ...job, status: 'ok', progress: 1, finishedAt: new Date().toISOString() },
    }
  }

  async listEngines(): Promise<EngineDescriptor[]> {
    await sleep(80)
    return fx.engines.map((e) => ({ ...e }))
  }

  async listProviders(): Promise<ModelProvider[]> {
    await sleep(60)
    return fx.providers.map((p) => ({ ...p }))
  }

  /**
   * У мока движков нет по определению — он существует, чтобы править интерфейс
   * без запущенного сервера. Пустой снимок здесь честнее выдуманного: иначе
   * вьюпорт показывал бы геометрию, которой нигде не существует.
   */
  async pullModel(): Promise<null> {
    await sleep(120)
    return null
  }

  /** У мока движка нет — отражать выделение и имена некуда. */
  async setSelection(): Promise<void> {
    await sleep(30)
  }

  async renameObject(): Promise<null> {
    await sleep(30)
    return null
  }

  async searchKnowledge(query: string): Promise<KnowledgeHit[]> {
    await sleep(200)
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits = fx.knowledge.filter(
      (h) =>
        h.title.toLowerCase().includes(q) ||
        h.excerpt.toLowerCase().includes(q) ||
        h.tags.some((tag) => tag.includes(q)),
    )
    return hits.length > 0 ? hits : fx.knowledge.slice(0, 2)
  }

  async saveGraph(sessionId: string, doc: GraphDoc): Promise<void> {
    await sleep(40)
    this.graphBySession.set(sessionId, structuredClone(doc))
    this.persist()
  }
}

/* ────────────────────────── вспомогательное ────────────────────────── */

/** Режем на «токены» по словам — стриминг должен выглядеть как настоящий. */
function chunkify(text: string): string[] {
  return text.split(/(\s+)/).filter((s) => s.length > 0)
}

function draftReply(prompt: string): string {
  const head = prompt.trim().slice(0, 60)
  return [
    `Принял: «${head}${prompt.length > 60 ? '…' : ''}».`,
    'Сначала раскладываю объект на отдельные части и фиксирую габарит в миллиметрах,',
    'затем строю каждую часть отдельным телом — без слипаний и взаимных пересечений.',
    'После сборки прогоню проверку дисциплины: замкнутость, коллизии, соответствие нормам.',
  ].join(' ')
}

function buildSnippet(prompt: string): string {
  return [
    '# ' + prompt.trim().slice(0, 48),
    'import rhinoscriptsyntax as rs',
    'import Rhino.Geometry as rg',
    '',
    'base = rg.Plane.WorldXY',
    'parts = build_parts(base, units="mm")',
    'report = discipline_report(parts)',
  ].join('\n')
}
