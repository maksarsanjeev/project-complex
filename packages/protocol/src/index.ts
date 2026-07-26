/**
 * PROJECT COMPLEX — протокол.
 *
 * Единственный источник правды по типам между веб-мордой и будущим gateway.
 * Фронтенд импортирует ровно те же структуры, которые потом будет отдавать
 * серверная часть, поэтому переход с MockTransport на WsTransport не требует
 * правок в компонентах.
 */

/* ────────────────────────────── базовое ────────────────────────────── */

/** ISO-8601, всегда UTC. */
export type Timestamp = string

export type Vec3 = readonly [number, number, number]

/** Внутренняя единица измерения всего пайплайна — миллиметр. */
export type Millimetres = number

/* ────────────────────────────── движки ────────────────────────────── */

export type EngineId = 'sketchup' | 'blender' | 'rhino'

export type EngineStatus = 'online' | 'offline' | 'busy' | 'error'

export interface EngineDescriptor {
  id: EngineId
  /** Отображаемое имя: SketchUp, Blender, Rhinoceros. */
  label: string
  status: EngineStatus
  /** Порт локального моста: 8080 / 9876 / 1999. */
  port: number
  /** Версия приложения, о которой отчитался мост. */
  version?: string
  /** Форматы, в которые этот движок умеет выгружать. */
  exports: ExportFormat[]
  /** Последний успешный пинг моста. */
  lastSeen?: Timestamp
  /**
   * Открытые окна приложения. У SketchUp их бывает до десятка сразу, каждое со
   * своей моделью и своим портом, поэтому движок — это не один адрес, а список.
   */
  instances?: EngineInstance[]
  /**
   * Машина, с которой доложили о движке. Агентов может быть несколько.
   */
  agent?: string
}

/**
 * Одно запущенное окно приложения. Для SketchUp сведения берутся из «визитки»,
 * которую плагин пишет о себе каждые две секунды.
 */
export interface EngineInstance {
  /** Устойчивый идентификатор окна; переживает переоткрытие модели. */
  id: string
  /** Порт моста именно этого окна. */
  port: number
  /** Имя открытой модели — по нему пользователь и опознаёт окно. */
  title?: string
  /** Путь к файлу модели, если она сохранена. */
  path?: string
  /** Версия приложения. */
  version?: string
  /**
   * Единица длины документа. У Rhino она произвольная, и это единственное
   * место, где может незаметно возникнуть ошибка в тысячу раз.
   */
  units?: string
  /**
   * Окно, с которым пользователь работал последним, — в него и уходит вызов,
   * когда окно не названо явно.
   *
   * Именно «последним», а не «активным сейчас»: пока человек пишет в чат,
   * активен браузер, и признак текущего фокуса не нашёл бы ни одного окна
   * ровно тогда, когда он нужен.
   */
  active?: boolean
}

export type ExportFormat =
  | 'skp'
  | '3dm'
  | 'fbx'
  | 'obj'
  | 'glb'
  | 'gltf'
  | 'stl'
  | 'step'
  | 'dae'
  | 'usd'

/* ────────────────────────────── модели ИИ ────────────────────────────── */

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'local'
  | 'gptimage'
  | 'nanobanana'

/**
 * Как именно подключена нейросеть.
 * `api` — прямой вызов по ключу.
 * `cli` — локально запущенный агент (codex / gemini / claude), который сам
 *         ходит в мозговой центр и влияет на ход работы.
 */
export type ProviderTransport = 'api' | 'cli'

export interface ModelProvider {
  id: string
  provider: ProviderId
  /** Идентификатор модели, напр. claude-opus-5. */
  model: string
  label: string
  transport: ProviderTransport
  /** Настроен ли ключ / доступен ли CLI-бинарь. */
  configured: boolean
  capabilities: ModelCapability[]
}

export type ModelCapability = 'text' | 'vision' | 'image-gen' | 'tools' | 'long-context'

/* ────────────────────────────── сессии ────────────────────────────── */

export type SessionStatus = 'idle' | 'running' | 'error' | 'done'

export interface Session {
  id: string
  /** Человекочитаемый ID-чип: SES-014. */
  code: string
  title: string
  project: string
  engine: EngineId
  status: SessionStatus
  createdAt: Timestamp
  updatedAt: Timestamp
  /** Кол-во сообщений — для превью в списке сессий. */
  messageCount: number
  /** Проставлено — сессия в корзине; удаление обратимо. */
  deletedAt?: Timestamp
}

export interface SessionState {
  session: Session
  messages: ChatMessage[]
  scene: SceneNode[]
  graph: GraphDoc
  /**
   * Последний снимок модели ИМЕННО ЭТОЙ сессии.
   *
   * Снимок привязан к сессии, а не к приложению: иначе новый проект показывает
   * модель предыдущего, и «проект» отличается от «проекта» только перепиской.
   */
  snapshot?: ModelSnapshot | null
}

/* ────────────────────────────── чат ────────────────────────────── */

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ChatAttachment {
  id: string
  kind: 'image' | 'model' | 'file'
  name: string
  /** data: или blob: URL — на моке это сгенерированный SVG. */
  url: string
  bytes?: number
}

export type ToolCallStatus = 'pending' | 'running' | 'ok' | 'error'

export interface ToolCall {
  id: string
  /** Имя MCP-инструмента, напр. rhino_io / su_ruby_execute. */
  name: string
  engine: EngineId
  status: ToolCallStatus
  /** Код, который реально ушёл в движок. */
  code?: string
  result?: string
  /** Длительность выполнения, мс. */
  durationMs?: number
}

export interface ChatMessage {
  id: string
  role: ChatRole
  /** Текст сообщения; у ассистента может дописываться стримингом. */
  content: string
  createdAt: Timestamp
  /** Какая модель ответила — для чипа роли. */
  model?: string
  attachments?: ChatAttachment[]
  toolCalls?: ToolCall[]
  /** true, пока идёт стриминг ответа. */
  streaming?: boolean
}

/** События потока ответа. */
export type ChatEvent =
  | { type: 'message-start'; message: ChatMessage }
  | { type: 'token'; messageId: string; text: string }
  | { type: 'tool-call'; messageId: string; toolCall: ToolCall }
  | { type: 'tool-update'; messageId: string; toolCall: ToolCall }
  | { type: 'scene-patch'; nodes: SceneNode[] }
  | { type: 'message-end'; messageId: string }
  | { type: 'error'; message: string }

/* ────────────────────────────── сцена ────────────────────────────── */

export type SceneNodeKind = 'layer' | 'group' | 'solid' | 'surface' | 'curve' | 'mesh' | 'block'

/**
 * Дерево сцены. Слои именуются ПО МАТЕРИАЛУ (кирпич / стекло / бетон / дерево),
 * а не по функции — это даёт назначение материала в один клик и совпадает
 * с дисциплиной организации файла, принятой в проекте.
 */
export interface SceneNode {
  id: string
  name: string
  kind: SceneNodeKind
  /** id родителя; null — корень. */
  parentId: string | null
  visible: boolean
  locked: boolean
  /** Материал объекта, если назначен. */
  material?: string
  /** Треугольников в узле и потомках — для статусбара. */
  triangles?: number
  /**
   * Тег объекта (в старых версиях SketchUp — «слой»).
   *
   * Тег НЕ содержит объектов: это ярлык для управления видимостью, а не
   * контейнер, как слой в Rhino или AutoCAD. Поэтому он поле узла, а не его
   * родитель — вложенность в SketchUp даёт только группа или компонент.
   */
  tag?: string
  /** Имя определения — только у компонентов. */
  definition?: string
  /**
   * Сколько экземпляров у определения этого компонента.
   *
   * Больше одного — правка одного экземпляра изменит все остальные. Это надо
   * видеть до правки, а не после.
   */
  instances?: number
}

/** Тег модели: ярлык видимости, не контейнер. */
export interface ModelTag {
  name: string
  visible: boolean
  /** Папка тегов, если он в неё вложен. */
  folder?: string | null
}

export interface ModelMaterial {
  name: string
  color?: { r: number; g: number; b: number } | null
  /** 1 — непрозрачный. */
  alpha: number
  textured: boolean
  /** Сколько объектов носит этот материал; 0 — заведён, но не используется. */
  used: number
}

/** Определение компонента или группы из библиотеки модели. */
export interface ModelDefinition {
  name: string
  instances: number
  /** Группа — это компонент с флагом; у неё копии независимы. */
  group: boolean
  entities: number
}

/**
 * Снимок модели из движка: и геометрия, и структура за один запрос.
 *
 * Почему не файл экспорта. Экспорт дал бы только треугольники, а вьюпорту
 * нужно ещё и дерево: слои по материалу, имена групп, кто чей родитель.
 * Собирая снимок на стороне моста, получаем и то и другое разом, без временных
 * файлов и без зависимости от доступных в этой редакции форматов экспорта.
 */
export interface ModelSnapshot {
  engine: EngineId
  /** Окно приложения, из которого снято. */
  instance?: string
  title: string
  /** Всегда 'mm' — перевод делает мост. */
  units: string
  triangles: number
  /** Модель оказалась больше предела: показано не всё. */
  truncated: boolean
  /** Дерево для аутлайнера. */
  nodes: SceneNode[]
  parts: MeshPart[]
  /** Теги модели — отдельным списком, а не ветками дерева. */
  tags?: ModelTag[]
  materials?: ModelMaterial[]
  definitions?: ModelDefinition[]
  /** Что выделено в самом движке на момент снимка: узлы вида `ent:43725`. */
  selection?: string[]
  /** Когда снято — вьюпорт показывает свежесть. */
  takenAt: Timestamp
}

/**
 * Что пользователь выделил в интерфейсе на момент отправки сообщения.
 *
 * Без этого «измени выделенный объект» для модели пустой звук: выделение
 * живёт в браузере и до сервера не доходит. Идентификатор узла вида
 * `ent:43725` несёт в себе настоящий entityID движка — тот самый, который уже
 * принимают инструменты правки, так что модели остаётся только его взять.
 */
export interface SelectionRef {
  /** Идентификатор узла дерева: `ent:43725` или `layer:бетон`. */
  id: string
  name: string
  layer?: string
  kind?: SceneNodeKind
}

/** Треугольники одного узла дерева. Координаты в миллиметрах, тройками. */
export interface MeshPart {
  /** Узел дерева, которому принадлежит геометрия. */
  nodeId: string
  layer: string
  triangles: number
  positions: number[]
  normals: number[]
}

/* ────────────────────────────── нодовый граф ────────────────────────────── */

export type NodeKind =
  | 'input.prompt'
  | 'input.image'
  | 'input.reference'
  | 'kb.query'
  | 'agent.llm'
  | 'engine.sketchup'
  | 'engine.blender'
  | 'engine.rhino'
  | 'op.boolean'
  | 'op.array'
  | 'op.fillet'
  | 'op.transform'
  | 'check.discipline'
  | 'output.export'

/** Тип порта задаётся ФОРМОЙ глифа, а не цветом: ● геометрия, ▲ параметры, ■ данные. */
export type PortType = 'geometry' | 'params' | 'data'

export type ParamType = 'number' | 'text' | 'boolean' | 'select'

/**
 * Описание одного редактируемого параметра узла. По нему инспектор строит поле
 * нужного вида, а исполнитель графа знает, что и в каких единицах ему пришло.
 */
export interface ParamSpec {
  key: string
  label: string
  type: ParamType
  /** Единица измерения для числовых полей: мм, °, шт. */
  unit?: string
  min?: number
  max?: number
  step?: number
  /** Варианты для типа select. */
  options?: string[]
  /** Значение нового узла. Без него порт движка создавался бы равным минимуму. */
  defaultValue?: ParamValue
}

export type ParamValue = string | number | boolean

export interface GraphPort {
  id: string
  name: string
  type: PortType
}

export interface GraphNode {
  id: string
  /** ID-чип узла: ND-07. */
  code: string
  kind: NodeKind
  title: string
  position: { x: number; y: number }
  inputs: GraphPort[]
  outputs: GraphPort[]
  /** Значения настроек узла; описание полей берётся из каталога типов. */
  params?: Record<string, ParamValue>
  status?: ToolCallStatus
}

export interface GraphEdge {
  id: string
  source: string
  sourcePort: string
  target: string
  targetPort: string
}

export interface GraphDoc {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/* ────────────────────────────── задачи ────────────────────────────── */

export type JobStatus = 'queued' | 'running' | 'ok' | 'error' | 'cancelled'

export interface JobSpec {
  sessionId: string
  engine: EngineId
  /** Что делаем: пересобрать граф, выгрузить, отрендерить превью. */
  action: 'build' | 'export' | 'render' | 'validate'
  format?: ExportFormat
}

export interface Job {
  id: string
  code: string
  spec: JobSpec
  status: JobStatus
  /** 0..1 */
  progress: number
  startedAt?: Timestamp
  finishedAt?: Timestamp
  message?: string
}

export type JobEvent =
  | { type: 'job-start'; job: Job }
  | { type: 'job-progress'; jobId: string; progress: number; message?: string }
  | { type: 'job-end'; job: Job }

/* ────────────────────────────── база знаний ────────────────────────────── */

export interface KnowledgeHit {
  id: string
  title: string
  /** Откуда знание: архив опыта, нормы, разбор референса. */
  source: string
  excerpt: string
  tags: string[]
  /** 0..1 */
  score: number
}

/* ────────────────────────────── конверт веб-сокета ────────────────────────────── */

/**
 * Формат обмена между веб-мордой и gateway. Одно соединение, в нём вперемешку
 * идут ответы на разные запросы — поэтому у каждого свой `id`.
 *
 * Обычный вызов: клиент шлёт `WireRequest`, сервер отвечает `result` или `error`.
 * Потоковый (`sendMessage`, `runJob`): сервер шлёт цепочку `event` с тем же `id`
 * и закрывает её `done`, а клиент собирает это обратно в асинхронный итератор.
 */
export interface WireRequest {
  id: string
  method: string
  params?: unknown
}

export type WireResponse =
  | { id: string; result: unknown }
  | { id: string; error: { message: string } }
  | { id: string; event: unknown }
  | { id: string; done: true }

/* ────────────────────────────── агент на машине пользователя ────────────────────────────── */

/**
 * Движки живут не там, где gateway: SketchUp, Rhino и Blender стоят на рабочей
 * машине, а gateway — на сервере. Связывает их агент, и связь эта устроена
 * НАОБОРОТ привычному: соединение всегда исходящее от агента.
 *
 * Так на машине пользователя не открывается ни одного входящего порта, мосты
 * остаются на 127.0.0.1, а файрвол не приходится трогать. Это не удобство, а
 * необходимость: у моста SketchUp есть execute_ruby, у Rhino и Blender —
 * выполнение произвольного кода. Открывать такое в сеть нельзя.
 *
 * Отдельный путь веб-сокета `/agent`, отдельный кадр — с веб-мордой у агента
 * нет ничего общего, кроме соединения.
 */
export type AgentFrame =
  /** Первый кадр: агент представляется и предъявляет токен. */
  | { type: 'hello'; token: string; machine: string; version: string }
  /** Что сейчас запущено на машине. Шлётся при изменениях, не по таймеру. */
  | { type: 'inventory'; engines: EngineDescriptor[] }
  /** Ответ на вызов; `id` совпадает с тем, что прислал gateway. */
  | { type: 'result'; id: string; ok: true; result: unknown; durationMs: number }
  | { type: 'result'; id: string; ok: false; error: string; durationMs: number }

/** Кадры в обратную сторону: gateway просит агента что-то сделать. */
export type GatewayFrame =
  | { type: 'welcome'; agentId: string }
  | { type: 'denied'; reason: string }
  /**
   * Вызов инструмента. `instance` указывает конкретное окно приложения; если
   * не задан и окно единственное, агент выбирает его сам.
   */
  | {
      type: 'invoke'
      id: string
      engine: EngineId
      instance?: string
      command: string
      params: Record<string, unknown>
    }

/* ────────────────────────────── транспорт ────────────────────────────── */

/**
 * Контракт доступа к бэкенду. Сейчас реализован моком, позже — веб-сокетом
 * к gateway. Компоненты знают только про этот интерфейс.
 */
export interface Transport {
  /** Живые сессии. Удалённые в корзину сюда не попадают. */
  listSessions(): Promise<Session[]>
  /** Содержимое корзины — удаление обратимо. */
  listTrash(): Promise<Session[]>
  openSession(sessionId: string): Promise<SessionState>
  createSession(input: { title: string; project: string; engine: EngineId }): Promise<Session>
  renameSession(sessionId: string, title: string): Promise<Session>
  /** Переносит в корзину. Безвозвратно удаляет только purgeSession. */
  deleteSession(sessionId: string): Promise<void>
  restoreSession(sessionId: string): Promise<void>
  purgeSession(sessionId: string): Promise<void>

  /**
   * Поиск по сессиям: заголовок, проект, код И содержимое переписки.
   * Поиск по тексту сообщений делает сервер — на клиенте нет всех диалогов.
   */
  searchSessions(query: string): Promise<Session[]>

  sendMessage(input: {
    sessionId: string
    text: string
    attachments?: ChatAttachment[]
    modelId: string
    /** Что выделено во вьюпорте — чтобы «измени выделенный» имел смысл. */
    selection?: SelectionRef[]
  }): AsyncIterable<ChatEvent>

  runJob(spec: JobSpec): AsyncIterable<JobEvent>

  listEngines(): Promise<EngineDescriptor[]>
  listProviders(): Promise<ModelProvider[]>
  searchKnowledge(query: string): Promise<KnowledgeHit[]>
  /**
   * Забрать модель из движка: геометрию и дерево. Возвращает null, когда
   * движок не запущен — это обычное положение дел, а не ошибка.
   */
  pullModel(input?: {
    engine?: EngineId
    instance?: string
    /** Куда сохранить снимок. Без него снимок вернётся, но не запомнится. */
    sessionId?: string
  }): Promise<ModelSnapshot | null>
  /**
   * Отразить выделение веб-морды в движке, чтобы человек видел на экране
   * приложения то же, что выделил в браузере.
   */
  setSelection(ids: string[], engine?: EngineId): Promise<void>
  /**
   * Переименовать объект в самом движке.
   *
   * Возвращает новый идентификатор узла: у россыпи граней имени в SketchUp нет
   * и быть не может, поэтому дать ей имя означает сгруппировать её — и узел
   * из `loose:…` становится `ent:…`.
   */
  renameObject(input: {
    nodeId: string
    name: string
    engine?: EngineId
  }): Promise<{ nodeId: string; grouped: boolean } | null>

  saveGraph(sessionId: string, doc: GraphDoc): Promise<void>
}
