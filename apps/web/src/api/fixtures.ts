import type {
  ChatMessage,
  EngineDescriptor,
  GraphDoc,
  KnowledgeHit,
  ModelProvider,
  SceneNode,
  Session,
} from '@complex/protocol'

/** Опорное время фикстур, чтобы список сессий выглядел живым. */
const T0 = Date.parse('2026-07-25T09:12:00Z')
const ago = (minutes: number): string => new Date(T0 - minutes * 60_000).toISOString()

/* ────────────────────────────── движки ────────────────────────────── */

export const engines: EngineDescriptor[] = [
  {
    id: 'rhino',
    label: 'Rhinoceros',
    status: 'online',
    port: 9890,
    version: '8.21',
    exports: ['3dm', 'obj', 'stl', 'step', 'glb', 'fbx', 'dae'],
    lastSeen: ago(1),
  },
  {
    id: 'sketchup',
    label: 'SketchUp',
    status: 'online',
    port: 8080,
    version: '2024',
    exports: ['skp', 'obj', 'fbx', 'dae', 'stl'],
    lastSeen: ago(4),
  },
  {
    id: 'blender',
    label: 'Blender',
    status: 'offline',
    port: 9876,
    version: '4.2',
    exports: ['glb', 'gltf', 'fbx', 'obj', 'stl', 'usd'],
  },
]

/* ────────────────────────────── модели ────────────────────────────── */

export const providers: ModelProvider[] = [
  {
    id: 'claude-opus-5-api',
    provider: 'anthropic',
    model: 'claude-opus-5',
    label: 'Claude Opus 5',
    transport: 'api',
    configured: true,
    capabilities: ['text', 'vision', 'tools', 'long-context'],
  },
  {
    id: 'claude-cli',
    provider: 'anthropic',
    model: 'claude-opus-5',
    label: 'Claude Code CLI',
    transport: 'cli',
    configured: true,
    capabilities: ['text', 'vision', 'tools', 'long-context'],
  },
  {
    id: 'codex-cli',
    provider: 'openai',
    model: 'codex',
    label: 'Codex CLI',
    transport: 'cli',
    configured: true,
    capabilities: ['text', 'tools'],
  },
  {
    id: 'gemini-cli',
    provider: 'google',
    model: 'gemini-3-pro',
    label: 'Gemini CLI',
    transport: 'cli',
    configured: false,
    capabilities: ['text', 'vision', 'tools'],
  },
  {
    id: 'qwen-local',
    provider: 'local',
    model: 'qwen3.5:4b',
    label: 'Qwen 3.5 4B — критик',
    transport: 'api',
    configured: true,
    capabilities: ['text', 'vision'],
  },
  {
    id: 'nanobanana-2',
    provider: 'nanobanana',
    model: 'nano-banana-2',
    label: 'Nano Banana 2',
    transport: 'api',
    configured: false,
    capabilities: ['image-gen'],
  },
]

/* ────────────────────────────── сессии ────────────────────────────── */

export const sessions: Session[] = [
  {
    id: 's-014',
    code: 'SES-014',
    title: 'Башня с диагридом, аттрактор по высоте',
    project: 'Aurora Tower',
    engine: 'rhino',
    status: 'running',
    createdAt: ago(96),
    updatedAt: ago(2),
    messageCount: 24,
  },
  {
    id: 's-013',
    code: 'SES-013',
    title: 'Окно в кирпичной стене, четверть 65×75',
    project: 'Карточки сборок',
    engine: 'rhino',
    status: 'done',
    createdAt: ago(320),
    updatedAt: ago(140),
    messageCount: 41,
  },
  {
    id: 's-012',
    code: 'SES-012',
    title: 'Диван трёхместный, мягкая обивка',
    project: 'Интерьер',
    engine: 'sketchup',
    status: 'idle',
    createdAt: ago(1450),
    updatedAt: ago(1180),
    messageCount: 17,
  },
  {
    id: 's-011',
    code: 'SES-011',
    title: 'Чистка GLB после Hunyuan, пересборка по частям',
    project: 'Интерьер',
    engine: 'blender',
    status: 'error',
    createdAt: ago(2600),
    updatedAt: ago(2410),
    messageCount: 9,
  },
  {
    id: 's-010',
    code: 'SES-010',
    title: 'Вилла: каскад плоских кровель, свесы 1800',
    project: 'Прерия',
    engine: 'rhino',
    status: 'done',
    createdAt: ago(4300),
    updatedAt: ago(3980),
    messageCount: 63,
  },
]

/* ────────────────────────────── сцена ────────────────────────────── */

/**
 * Слои именуются ПО МАТЕРИАЛУ — так материал назначается в один клик,
 * и так организованы рабочие файлы проекта.
 */
export const scene: SceneNode[] = [
  { id: 'l-1', name: 'бетон', kind: 'layer', parentId: null, visible: true, locked: false, material: 'бетон', triangles: 18_420 },
  { id: 'n-11', name: 'плита_основания', kind: 'solid', parentId: 'l-1', visible: true, locked: false, triangles: 1_240 },
  { id: 'n-12', name: 'ядро_жёсткости', kind: 'solid', parentId: 'l-1', visible: true, locked: true, triangles: 8_960 },
  { id: 'n-13', name: 'перекрытия_x24', kind: 'group', parentId: 'l-1', visible: true, locked: false, triangles: 8_220 },

  { id: 'l-2', name: 'стекло', kind: 'layer', parentId: null, visible: true, locked: false, material: 'стекло', triangles: 42_100 },
  { id: 'n-21', name: 'витраж_панели', kind: 'surface', parentId: 'l-2', visible: true, locked: false, triangles: 31_800 },
  { id: 'n-22', name: 'остекление_кровли', kind: 'surface', parentId: 'l-2', visible: false, locked: false, triangles: 10_300 },

  { id: 'l-3', name: 'железо', kind: 'layer', parentId: null, visible: true, locked: false, material: 'железо', triangles: 96_540 },
  { id: 'n-31', name: 'диагрид_несущий', kind: 'solid', parentId: 'l-3', visible: true, locked: false, triangles: 74_200 },
  { id: 'n-32', name: 'узлы_соединений', kind: 'group', parentId: 'l-3', visible: true, locked: false, triangles: 22_340 },

  { id: 'l-4', name: 'основа', kind: 'layer', parentId: null, visible: true, locked: true, material: 'основа', triangles: 2 },
  { id: 'n-41', name: 'подложка_752x464м', kind: 'mesh', parentId: 'l-4', visible: true, locked: true, triangles: 2 },

  { id: 'l-5', name: 'антураж', kind: 'layer', parentId: null, visible: true, locked: false, material: 'блоки', triangles: 210_880 },
  { id: 'n-51', name: 'дерево_каштан_x12', kind: 'block', parentId: 'l-5', visible: true, locked: false, triangles: 148_600 },
  { id: 'n-52', name: 'фигуры_масштаба_x4', kind: 'block', parentId: 'l-5', visible: true, locked: false, triangles: 62_280 },
]

/* ────────────────────────────── граф ────────────────────────────── */

export const graph: GraphDoc = {
  nodes: [
    {
      id: 'nd-01',
      code: 'ND-01',
      kind: 'input.prompt',
      title: 'Промпт',
      position: { x: 40, y: 120 },
      inputs: [],
      outputs: [{ id: 'out', name: 'текст', type: 'data' }],
      params: { text: 'башня 42 этажа, диагрид, кручение 18°' },
      status: 'ok',
    },
    {
      id: 'nd-02',
      code: 'ND-02',
      kind: 'input.image',
      title: 'Референс',
      position: { x: 40, y: 268 },
      inputs: [],
      outputs: [{ id: 'out', name: 'изобр', type: 'data' }],
      params: { files: 2 },
      status: 'ok',
    },
    {
      id: 'nd-03',
      code: 'ND-03',
      kind: 'kb.query',
      title: 'База знаний',
      position: { x: 300, y: 200 },
      inputs: [{ id: 'q', name: 'запрос', type: 'data' }],
      outputs: [{ id: 'ctx', name: 'контекст', type: 'data' }],
      params: { collection: 'нормы + сборки', topK: 6 },
      status: 'ok',
    },
    {
      id: 'nd-04',
      code: 'ND-04',
      kind: 'agent.llm',
      title: 'Агент',
      position: { x: 560, y: 150 },
      inputs: [
        { id: 'prompt', name: 'промпт', type: 'data' },
        { id: 'ctx', name: 'контекст', type: 'data' },
      ],
      outputs: [{ id: 'plan', name: 'план', type: 'params' }],
      params: { model: 'claude-opus-5', transport: 'api', selfReview: true },
      status: 'running',
    },
    {
      id: 'nd-05',
      code: 'ND-05',
      kind: 'engine.rhino',
      title: 'Rhino',
      position: { x: 830, y: 120 },
      inputs: [{ id: 'plan', name: 'план', type: 'params' }],
      outputs: [{ id: 'geo', name: 'геометрия', type: 'geometry' }],
      params: { port: 9890, grasshopper: true },
      status: 'pending',
    },
    {
      id: 'nd-06',
      code: 'ND-06',
      kind: 'op.array',
      title: 'Массив',
      position: { x: 830, y: 296 },
      inputs: [{ id: 'geo', name: 'геометрия', type: 'geometry' }],
      outputs: [{ id: 'geo', name: 'геометрия', type: 'geometry' }],
      params: { count: 42, stepZ: 3600 },
      status: 'pending',
    },
    {
      id: 'nd-07',
      code: 'ND-07',
      kind: 'check.discipline',
      title: 'Дисциплина',
      position: { x: 1090, y: 200 },
      inputs: [{ id: 'geo', name: 'геометрия', type: 'geometry' }],
      outputs: [{ id: 'geo', name: 'геометрия', type: 'geometry' }],
      params: { watertight: true, collisions: true, norms: true },
      status: 'pending',
    },
    {
      id: 'nd-08',
      code: 'ND-08',
      kind: 'output.export',
      title: 'Экспорт',
      position: { x: 1340, y: 200 },
      inputs: [{ id: 'geo', name: 'геометрия', type: 'geometry' }],
      outputs: [],
      params: { format: '3dm' },
      status: 'pending',
    },
  ],
  edges: [
    { id: 'e1', source: 'nd-01', sourcePort: 'out', target: 'nd-03', targetPort: 'q' },
    { id: 'e2', source: 'nd-01', sourcePort: 'out', target: 'nd-04', targetPort: 'prompt' },
    { id: 'e3', source: 'nd-02', sourcePort: 'out', target: 'nd-03', targetPort: 'q' },
    { id: 'e4', source: 'nd-03', sourcePort: 'ctx', target: 'nd-04', targetPort: 'ctx' },
    { id: 'e5', source: 'nd-04', sourcePort: 'plan', target: 'nd-05', targetPort: 'plan' },
    { id: 'e6', source: 'nd-05', sourcePort: 'geo', target: 'nd-06', targetPort: 'geo' },
    { id: 'e7', source: 'nd-05', sourcePort: 'geo', target: 'nd-07', targetPort: 'geo' },
    { id: 'e8', source: 'nd-06', sourcePort: 'geo', target: 'nd-07', targetPort: 'geo' },
    { id: 'e9', source: 'nd-07', sourcePort: 'geo', target: 'nd-08', targetPort: 'geo' },
  ],
}

/* ────────────────────────────── диалог ────────────────────────────── */

export const messages: ChatMessage[] = [
  {
    id: 'm-1',
    role: 'user',
    content:
      'Собери башню 42 этажа с диагридом. Кручение по высоте 18°, шаг этажа 3600. Ядро жёсткости монолитное, витраж между рёбрами.',
    createdAt: ago(58),
  },
  {
    id: 'm-2',
    role: 'assistant',
    model: 'claude-opus-5',
    content:
      'Разбиваю на части: ядро, перекрытия, диагрид, витраж. Сначала подниму направляющие и проверю шаг — при 42 × 3600 общая высота 151 200 мм, парапет добавлю отдельно.',
    createdAt: ago(57),
    toolCalls: [
      {
        id: 'tc-1',
        name: 'rhino_docs',
        engine: 'rhino',
        status: 'ok',
        code: "rhino_docs(action='signature', symbol='rs.AddPipe')",
        result: 'AddPipe ожидает НОРМАЛИЗОВАННЫЕ параметры [0..1]',
        durationMs: 340,
      },
      {
        id: 'tc-2',
        name: 'rhino_exec',
        engine: 'rhino',
        status: 'ok',
        code: 'rails = [rg.Line(p0, p1) for ...]\nbrep = rg.Brep.CreateFromSweep(profile, rail, False)',
        result: '84 брепа, все замкнуты',
        durationMs: 4_120,
      },
    ],
  },
  {
    id: 'm-3',
    role: 'user',
    content: 'Рёбра слишком тонкие на верхних этажах. Сделай сечение постоянным.',
    createdAt: ago(31),
  },
  {
    id: 'm-4',
    role: 'assistant',
    model: 'claude-opus-5',
    content:
      'Причина — профиль скейлился вместе с контуром этажа. Развожу: контур задаёт трассу, профиль строю в плоскости с фиксированным сечением 400×900. Пересобираю диагрид.',
    createdAt: ago(30),
    toolCalls: [
      {
        id: 'tc-3',
        name: 'rhino_exec',
        engine: 'rhino',
        status: 'ok',
        code: 'plane = rg.Plane(pt, tangent)\nplane = align_up(plane)  # in-plane Y = проекция мирового Z',
        result: '168 рёбер, сечение постоянное',
        durationMs: 7_880,
      },
      {
        id: 'tc-4',
        name: 'rhino_io',
        engine: 'rhino',
        status: 'ok',
        code: "rhino_io(action='check_solids')",
        result: 'замкнутых 168 / 168, самопересечений нет',
        durationMs: 1_460,
      },
    ],
  },
  {
    id: 'm-5',
    role: 'user',
    content: 'Хорошо. Теперь витраж между рёбрами и выгрузи в 3dm.',
    createdAt: ago(3),
  },
]

/* ────────────────────────────── база знаний ────────────────────────────── */

export const knowledge: KnowledgeHit[] = [
  {
    id: 'kb-1',
    title: 'Четверть оконного проёма 65×75',
    source: 'нормы / карточки сборок',
    excerpt:
      'Четверть 65×75 мм, растворные ленты −8 мм от лица кладки, подоконник 850–900 мм от чистого пола.',
    tags: ['окно', 'кирпич', 'нормы'],
    score: 0.94,
  },
  {
    id: 'kb-2',
    title: 'Sweep вдоль дуги: ориентация профиля',
    source: 'архив опыта / rhino-mcp',
    excerpt:
      'Плоскость профиля строить так, чтобы внутриплоскостная Y была проекцией мирового Z — иначе двутавр заваливается.',
    tags: ['rhino', 'sweep', 'гоча'],
    score: 0.88,
  },
  {
    id: 'kb-3',
    title: 'Каскад плоских кровель, прерия',
    source: 'разбор референса / livehome',
    excerpt:
      'Множество тонких плит на 2–3 отметках с глубокими консольными свесами, в плане перекрываются вертушкой.',
    tags: ['вилла', 'кровля', 'композиция'],
    score: 0.81,
  },
  {
    id: 'kb-4',
    title: 'Extrusion.Create и направление выдавливания',
    source: 'архив опыта / rhino-mcp',
    excerpt:
      'Выдавливание идёт по нормали плоскости кривой, знак зависит от обхода контура. Надёжно: построить и сдвинуть по min.Z.',
    tags: ['rhino', 'extrude', 'гоча'],
    score: 0.77,
  },
]
