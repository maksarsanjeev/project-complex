import type {
  ChatEvent,
  ChatMessage,
  EngineDescriptor,
  EngineId,
  GraphDoc,
  Job,
  JobEvent,
  JobSpec,
  KnowledgeHit,
  ModelSnapshot,
  ModelProvider,
  SelectionRef,
} from '@complex/protocol'
import * as agents from './agents.ts'
import { streamAnswer } from './chat.ts'
import { config } from './config.ts'
import { newId, nowIso } from './db/db.ts'
import * as repo from './db/repo.ts'

const USER = config.singleUserId

/**
 * Движки, которые проект знает в лицо. Порты — те, что слушают мосты по
 * умолчанию: наш плагин SketchUp, сторонний rhinomcp и сторонний blender-mcp.
 * Живые данные приходят от агента и перекрывают эти поля.
 */
const KNOWN_ENGINES: EngineDescriptor[] = [
  {
    id: 'rhino',
    label: 'Rhinoceros',
    status: 'offline',
    port: 1999,
    exports: ['3dm', 'obj', 'stl', 'step', 'glb', 'fbx', 'dae'],
  },
  {
    id: 'sketchup',
    label: 'SketchUp',
    status: 'offline',
    port: 8080,
    exports: ['skp', 'obj', 'fbx', 'dae', 'stl'],
  },
  {
    id: 'blender',
    label: 'Blender',
    status: 'offline',
    port: 9876,
    exports: ['glb', 'gltf', 'fbx', 'obj', 'stl', 'usd'],
  },
]

/** Обычный вызов: параметры на входе, готовый ответ на выходе. */
type Method = (params: Record<string, unknown>) => unknown

/** Потоковый вызов: события идут по мере готовности. */
type StreamMethod = (params: Record<string, unknown>) => AsyncGenerator<unknown>

const s = (v: unknown): string => String(v ?? '')

export const methods: Record<string, Method> = {
  listSessions: () => repo.listSessions(USER),
  listTrash: () => repo.listTrash(USER),
  searchSessions: (p) => repo.searchSessions(USER, s(p.query)),

  openSession: (p) => {
    const state = repo.openSession(USER, s(p.sessionId))
    if (!state) throw new Error(`сессия ${s(p.sessionId)} не найдена`)
    return state
  },

  createSession: (p) =>
    repo.createSession(USER, {
      title: s(p.title) || 'Без названия',
      project: s(p.project) || 'Черновики',
      engine: (s(p.engine) || 'rhino') as EngineId,
    }),

  renameSession: (p) => repo.renameSession(USER, s(p.sessionId), s(p.title)),
  deleteSession: (p) => repo.deleteSession(USER, s(p.sessionId)),
  restoreSession: (p) => repo.restoreSession(USER, s(p.sessionId)),
  purgeSession: (p) => repo.purgeSession(USER, s(p.sessionId)),

  saveGraph: (p) => repo.saveGraph(s(p.sessionId), p.doc as GraphDoc),

  /**
   * Движки: три известных нам всегда в списке, но их состояние берётся у
   * подключённых агентов. Раньше здесь стояла константа `offline`, и панель
   * движков показывала её независимо от того, что запущено на самом деле.
   *
   * Полный список нужен даже когда всё выключено: пользователь должен видеть,
   * какие движки бывают, а не пустую панель.
   */
  listEngines: (): EngineDescriptor[] => {
    const live = new Map(agents.listLiveEngines().map((engine) => [engine.id, engine]))
    return KNOWN_ENGINES.map((known) => ({ ...known, ...(live.get(known.id) ?? {}) }))
  },

  // Цены за миллион токенов сверены со списком OpenRouter 2026-07-26.
  listProviders: (): ModelProvider[] => [
    {
      id: 'sonnet-5',
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      // $2 / $10, контекст 1М — рабочая лошадка на каждый день
      label: 'Claude Sonnet 5',
      transport: 'api',
      configured: Boolean(config.openRouterKey),
      capabilities: ['text', 'vision', 'tools', 'long-context'],
    },
    {
      id: 'opus-5',
      provider: 'anthropic',
      model: 'anthropic/claude-opus-5',
      // $5 / $25, контекст 1М — втрое дешевле прежнего Opus 4.1 и умнее
      label: 'Claude Opus 5',
      transport: 'api',
      configured: Boolean(config.openRouterKey),
      capabilities: ['text', 'vision', 'tools', 'long-context'],
    },
    {
      id: 'haiku-4-5',
      provider: 'anthropic',
      model: 'anthropic/claude-haiku-4.5',
      // $1 / $5 — под мелкие проверки и роль критика на рендерах
      label: 'Claude Haiku 4.5',
      transport: 'api',
      configured: Boolean(config.openRouterKey),
      capabilities: ['text', 'vision', 'tools'],
    },
    // CLI-агенты появятся вместе с агентом на машине пользователя.
    {
      id: 'claude-cli',
      provider: 'anthropic',
      model: 'claude-opus-5',
      label: 'Claude Code CLI',
      transport: 'cli',
      configured: false,
      capabilities: ['text', 'vision', 'tools', 'long-context'],
    },
  ],

  /**
   * Снимок модели из движка для вьюпорта.
   *
   * Движок не запущен — возвращаем null, а не бросаем ошибку: это обычное
   * состояние, и веб-морда должна просто показать пустую сцену, а не ругаться
   * красным на каждой загрузке страницы.
   */
  pullModel: async (p): Promise<ModelSnapshot | null> => {
    const engine = (s(p.engine) || 'sketchup') as EngineId
    if (!agents.isOnline(engine)) return null

    const instance = s(p.instance) || undefined
    const raw = (await agents.invoke({
      engine,
      instance,
      command: 'GET /model/mesh',
      params: {},
    })) as Omit<ModelSnapshot, 'engine' | 'instance' | 'takenAt'>

    return { ...raw, engine, instance, takenAt: nowIso() }
  },

  /** База знаний — отдельный этап; пока честно отдаём пустоту. */
  searchKnowledge: (): KnowledgeHit[] => [],
}

export const streamMethods: Record<string, StreamMethod> = {
  async *sendMessage(p) {
    const sessionId = s(p.sessionId)
    const text = s(p.text)

    // Сообщение пользователя сохраняем сразу: если ответ модели оборвётся,
    // вопрос всё равно останется в переписке.
    const user: ChatMessage = {
      id: newId('u'),
      role: 'user',
      content: text,
      createdAt: nowIso(),
    }
    repo.appendMessage(sessionId, user)

    const providers = methods.listProviders({}) as ModelProvider[]
    const provider = providers.find((x) => x.id === s(p.modelId))
    const selection = (p.selection as SelectionRef | undefined) ?? undefined

    for await (const event of streamAnswer({ sessionId, text, provider, selection })) {
      yield event satisfies ChatEvent
    }
  },

  /** Задачи заработают вместе с движками; пока показываем честный отказ. */
  async *runJob(p) {
    const spec = p as unknown as JobSpec
    const job: Job = {
      id: newId('j'),
      code: `JOB-${Math.floor(Math.random() * 900 + 100)}`,
      spec,
      status: 'running',
      progress: 0,
      startedAt: nowIso(),
    }
    yield { type: 'job-start', job } satisfies JobEvent
    yield {
      type: 'job-progress',
      jobId: job.id,
      progress: 1,
      message: 'движки ещё не подключены',
    } satisfies JobEvent
    yield {
      type: 'job-end',
      job: { ...job, status: 'error', progress: 1, finishedAt: nowIso() },
    } satisfies JobEvent
  },
}
