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
import { cliConfigured } from './llm/claudeCode.ts'
import { rhinoScript } from './tools/scripts.ts'
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

/**
 * Приставка движка к идентификаторам узлов: `su:ent:43725`.
 *
 * Один проект бывает открыт сразу в трёх приложениях, а номера объектов у всех
 * свои и начинаются с малых чисел — без приставки они бы столкнулись, и клик
 * по группе SketchUp выделял бы слой Rhino. Делается здесь, а не в веб-морде:
 * дальше по системе идентификатор уже уникален, и думать о движке не нужно.
 */
const PREFIX: Record<EngineId, string> = { sketchup: 'su', rhino: 'rh', blender: 'bl' }

/**
 * Чем спросить снимок у каждого движка.
 *
 * У SketchUp это наш собственный маршрут: мост писали мы, и он сразу отдаёт
 * готовую структуру. У Rhino моста нашего нет — там чужой плагин, и всё, что
 * он умеет, это выполнить питон и вернуть НАПЕЧАТАННОЕ. Поэтому снимок Rhino
 * приходит строкой, которую надо разобрать (см. `parseSnapshot`).
 */
function snapshotCall(engine: EngineId): { command: string; params: Record<string, unknown> } {
  if (engine === 'rhino') {
    // Команда наша, не плагина: агент выполнит скрипт и прочитает файл,
    // который тот напишет. Через печать плагина такой объём не проходит.
    return { command: 'complex_snapshot', params: { code: rhinoScript('snapshot.py') } }
  }
  return { command: 'GET /model/mesh', params: {} }
}

/**
 * Снимок Rhino приезжает напечатанной строкой внутри `{success, output}`.
 *
 * Разбирать приходится здесь, а не в скрипте: печать — единственный канал,
 * который даёт чужой плагин. Не разобралось — виновата не структура, а сама
 * передача, и об этом надо сказать словами, иначе на экране будет пустая сцена
 * без объяснения.
 */
function parseSnapshot(engine: EngineId, raw: unknown): Record<string, unknown> {
  if (engine !== 'rhino') return raw as Record<string, unknown>

  // Агент отдаёт уже разобранный файл. Пустота здесь означает, что снимок не
  // дошёл, а не что модель пуста, — и сказать об этом надо словами.
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { nodes?: unknown }).nodes)) {
    throw new Error('Снимок Rhino не дошёл: агент вернул не структуру документа')
  }
  return raw as Record<string, unknown>
}

function namespace(snapshot: ModelSnapshot, engine: EngineId): ModelSnapshot {
  const p = PREFIX[engine]
  const id = (raw: string): string => `${p}:${raw}`

  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      id: id(node.id),
      parentId: node.parentId ? id(node.parentId) : null,
      engine,
    })),
    parts: snapshot.parts.map((part) => ({ ...part, nodeId: id(part.nodeId) })),
    selection: snapshot.selection?.map(id),
    // Теги, материалы и определения тоже адресуемы: их переименовывают так же,
    // как объекты, и идентификатор нужен по той же причине — имена в разных
    // движках совпадают, «Бетон» есть и в SketchUp, и в Rhino.
    tags: snapshot.tags?.map((x) => ({ ...x, id: id(`tag:${x.name}`) })),
    materials: snapshot.materials?.map((x) => ({ ...x, id: id(`material:${x.name}`) })),
    definitions: snapshot.definitions?.map((x) => ({ ...x, id: id(`definition:${x.name}`) })),
  }
}

/** Обратно: из `su:ent:43725` в движок и его собственный идентификатор. */
function denamespace(nodeId: string): { engine: EngineId; id: string } | null {
  const [prefix, ...rest] = nodeId.split(':')
  const engine = (Object.keys(PREFIX) as EngineId[]).find((e) => PREFIX[e] === prefix)
  return engine ? { engine, id: rest.join(':') } : null
}

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
    // Тот же движок, что у Claude Code, библиотекой внутри gateway. Цикл
    // инструментов крутит SDK, кэш разговора держит он же — на повторных ходах
    // это заметно дешевле, чем собирать историю самим.
    {
      id: 'claude-cli',
      provider: 'anthropic',
      model: 'claude-opus-5',
      label: 'Claude Opus 5 (Agent SDK)',
      transport: 'cli',
      configured: cliConfigured(),
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
    const answer = await agents.invoke({ engine, instance, ...snapshotCall(engine) })
    const raw = parseSnapshot(engine, answer) as unknown as Omit<
      ModelSnapshot,
      'engine' | 'instance' | 'takenAt'
    >

    const snapshot: ModelSnapshot = namespace(
      { ...raw, engine, instance, takenAt: nowIso() },
      engine,
    )

    // Кладём снимок в ту сессию, в которой работали. Иначе он один на всё
    // приложение, и открыв другой проект, человек видит чужую модель.
    const sessionId = s(p.sessionId)
    if (sessionId) repo.saveSnapshot(sessionId, snapshot)

    return snapshot
  },

  /**
   * Отразить выделение веб-морды в самом движке.
   *
   * Без этого выделений два и они не связаны: человек выделяет объект в
   * браузере, а в SketchUp подсвечено что-то своё. На вопрос «что я выделил»
   * это давало прямо противоречивые ответы.
   */
  setSelection: async (p): Promise<{ ok: boolean }> => {
    // Движок определяется по самим идентификаторам: выделение может лежать в
    // любой ветке дерева, и указывать его отдельно было бы лишним поводом
    // ошибиться. Разные движки разводим по своим вызовам.
    const byEngine = new Map<EngineId, number[]>()
    for (const raw of Array.isArray(p.ids) ? p.ids : []) {
      const parsed = denamespace(String(raw))
      if (!parsed) continue
      const numeric = Number(parsed.id.replace(/^ent:/, ''))
      if (!Number.isFinite(numeric)) continue
      byEngine.set(parsed.engine, [...(byEngine.get(parsed.engine) ?? []), numeric])
    }

    // Движкам без выделения тоже сообщаем — иначе там останется старая подсветка.
    for (const engine of Object.keys(PREFIX) as EngineId[]) {
      if (!agents.isOnline(engine)) continue
      const ids = byEngine.get(engine) ?? []
      if (!ids.length && !byEngine.size) continue
      await agents.invoke({
        engine,
        command: 'POST /model/selection',
        params: { entity_ids: ids },
      })
    }
    return { ok: true }
  },

  /**
   * Переименовать объект в движке. Имя, введённое в дереве сцены, должно
   * оказаться в самом приложении — иначе список и модель разъедутся.
   */
  renameObject: async (p): Promise<{ nodeId: string; grouped: boolean } | null> => {
    const parsed = denamespace(s(p.nodeId))
    if (!parsed) throw new Error(`непонятный идентификатор узла: ${s(p.nodeId)}`)
    if (!agents.isOnline(parsed.engine)) return null

    const raw = (await agents.invoke({
      engine: parsed.engine,
      command: 'POST /model/rename',
      params: { node_id: parsed.id, name: s(p.name) },
    })) as { node_id?: string; grouped?: boolean; confirmed?: boolean }

    if (raw.confirmed === false) throw new Error('движок не подтвердил новое имя')
    return {
      nodeId: `${PREFIX[parsed.engine]}:${s(raw.node_id)}`,
      grouped: Boolean(raw.grouped),
    }
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
    const selection = (p.selection as SelectionRef[] | undefined) ?? undefined

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
