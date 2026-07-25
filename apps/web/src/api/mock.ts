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
  Session,
  SessionState,
  Transport,
} from '@complex/protocol'

import * as fx from './fixtures'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let counter = 0
const nextId = (prefix: string): string => `${prefix}-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/**
 * Заглушка бэкенда: те же сигнатуры и тот же стриминг, что будут у gateway.
 * Компоненты работают только через интерфейс Transport, поэтому подмена
 * этого класса на WsTransport не потребует правок в UI.
 */
export class MockTransport implements Transport {
  private sessions: Session[] = fx.sessions.map((s) => ({ ...s }))
  private messagesBySession = new Map<string, ChatMessage[]>()
  private graphBySession = new Map<string, GraphDoc>()

  async listSessions(): Promise<Session[]> {
    await sleep(120)
    return this.sessions.map((s) => ({ ...s }))
  }

  async openSession(sessionId: string): Promise<SessionState> {
    await sleep(180)
    const session = this.sessions.find((s) => s.id === sessionId) ?? this.sessions[0]
    if (!session) throw new Error('нет ни одной сессии')

    const messages =
      this.messagesBySession.get(session.id) ??
      // Наполняем диалогом только «живую» сессию, остальные открываются пустыми.
      (session.id === 's-014' ? fx.messages.map((m) => ({ ...m })) : [])
    this.messagesBySession.set(session.id, messages)

    const graph = this.graphBySession.get(session.id) ?? structuredClone(fx.graph)
    this.graphBySession.set(session.id, graph)

    return { session: { ...session }, messages, scene: fx.scene.map((n) => ({ ...n })), graph }
  }

  async createSession(input: {
    title: string
    project: string
    engine: EngineId
  }): Promise<Session> {
    await sleep(140)
    const n = this.sessions.length + 11
    const now = new Date().toISOString()
    const session: Session = {
      id: nextId('s'),
      code: `SES-${String(n).padStart(3, '0')}`,
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
    return { ...session }
  }

  async *sendMessage(input: {
    sessionId: string
    text: string
    attachments?: ChatAttachment[]
    modelId: string
  }): AsyncIterable<ChatEvent> {
    const provider = fx.providers.find((p) => p.id === input.modelId)
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

    await sleep(260)
    yield { type: 'message-start', message }

    const reply = draftReply(input.text)
    for (const chunk of chunkify(reply)) {
      await sleep(18 + Math.random() * 26)
      yield { type: 'token', messageId, text: chunk }
    }

    // Один инструментальный вызов, чтобы был виден жизненный цикл блока.
    const call = {
      id: nextId('tc'),
      name: 'rhino_exec',
      engine: 'rhino' as EngineId,
      status: 'running' as const,
      code: buildSnippet(input.text),
    }
    yield { type: 'tool-call', messageId, toolCall: call }

    await sleep(900)
    yield {
      type: 'tool-update',
      messageId,
      toolCall: {
        ...call,
        status: 'ok',
        result: 'геометрия построена, замкнутых тел 100%',
        durationMs: 900 + Math.round(Math.random() * 3200),
      },
    }

    await sleep(200)
    yield { type: 'message-end', messageId }
  }

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
    await sleep(90)
    return fx.engines.map((e) => ({ ...e }))
  }

  async listProviders(): Promise<ModelProvider[]> {
    await sleep(70)
    return fx.providers.map((p) => ({ ...p }))
  }

  async searchKnowledge(query: string): Promise<KnowledgeHit[]> {
    await sleep(220)
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
    await sleep(80)
    this.graphBySession.set(sessionId, structuredClone(doc))
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
