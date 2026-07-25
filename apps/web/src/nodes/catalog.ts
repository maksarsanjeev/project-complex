import type { GraphPort, NodeKind, ParamSpec, ParamValue, PortType } from '@complex/protocol'

interface KindSpec {
  title: string
  /** Группа в палитре узлов. */
  group: 'вход' | 'знание' | 'агент' | 'движок' | 'операция' | 'проверка' | 'выход'
  inputs: GraphPort[]
  outputs: GraphPort[]
  /** Редактируемые настройки узла — по ним инспектор строит поля. */
  params: ParamSpec[]
}

const geo = (id: string, name: string): GraphPort => ({ id, name, type: 'geometry' })
const par = (id: string, name: string): GraphPort => ({ id, name, type: 'params' })
const dat = (id: string, name: string): GraphPort => ({ id, name, type: 'data' })

const mm = (key: string, label: string, step = 10): ParamSpec => ({
  key,
  label,
  type: 'number',
  unit: 'мм',
  step,
})

/** Описание типов узлов: заголовок, группа палитры, порты, настройки. */
export const NODE_KINDS: Record<NodeKind, KindSpec> = {
  'input.prompt': {
    title: 'Промпт',
    group: 'вход',
    inputs: [],
    outputs: [dat('out', 'текст')],
    params: [{ key: 'text', label: 'текст', type: 'text' }],
  },
  'input.image': {
    title: 'Референс',
    group: 'вход',
    inputs: [],
    outputs: [dat('out', 'изобр')],
    params: [
      { key: 'files', label: 'файлов', type: 'number', unit: 'шт', min: 0, max: 32 },
      { key: 'weight', label: 'влияние', type: 'number', min: 0, max: 100, unit: '%' },
    ],
  },
  'input.reference': {
    title: 'Образец',
    group: 'вход',
    inputs: [],
    outputs: [geo('out', 'геометрия')],
    params: [
      { key: 'path', label: 'файл', type: 'text' },
      { key: 'keepMaterials', label: 'материалы', type: 'boolean' },
    ],
  },
  'kb.query': {
    title: 'База знаний',
    group: 'знание',
    inputs: [dat('q', 'запрос')],
    outputs: [dat('ctx', 'контекст')],
    params: [
      {
        key: 'collection',
        label: 'раздел',
        type: 'select',
        options: ['нормы', 'сборки', 'разборы', 'нормы + сборки', 'всё'],
      },
      { key: 'topK', label: 'выдача', type: 'number', min: 1, max: 32, defaultValue: 6 },
    ],
  },
  'agent.llm': {
    title: 'Агент',
    group: 'агент',
    inputs: [dat('prompt', 'промпт'), dat('ctx', 'контекст')],
    outputs: [par('plan', 'план')],
    params: [
      {
        key: 'model',
        label: 'модель',
        type: 'select',
        options: ['claude-opus-5', 'claude-sonnet-5', 'codex', 'gemini-3-pro', 'qwen3.5:4b'],
      },
      { key: 'transport', label: 'подключение', type: 'select', options: ['api', 'cli'] },
      // Те самые тумблеры, которые агент спрашивает в начале задачи.
      { key: 'selfReview', label: 'самопроверка', type: 'boolean', defaultValue: true },
      { key: 'autoGroup', label: 'группировать', type: 'boolean', defaultValue: true },
      { key: 'discipline', label: 'дисциплина', type: 'boolean', defaultValue: true },
    ],
  },
  'engine.sketchup': {
    title: 'SketchUp',
    group: 'движок',
    inputs: [par('plan', 'план')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      { key: 'port', label: 'порт', type: 'number', min: 1, max: 65535, defaultValue: 8080 },
      { key: 'components', label: 'компоненты', type: 'boolean', defaultValue: true },
    ],
  },
  'engine.blender': {
    title: 'Blender',
    group: 'движок',
    inputs: [par('plan', 'план')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      { key: 'port', label: 'порт', type: 'number', min: 1, max: 65535, defaultValue: 9876 },
      {
        key: 'maxPolys',
        label: 'полигонов',
        type: 'number',
        min: 1000,
        max: 500000,
        step: 1000,
        defaultValue: 10000,
      },
    ],
  },
  'engine.rhino': {
    title: 'Rhino',
    group: 'движок',
    inputs: [par('plan', 'план')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      { key: 'port', label: 'порт', type: 'number', min: 1, max: 65535, defaultValue: 9890 },
      { key: 'grasshopper', label: 'grasshopper', type: 'boolean', defaultValue: true },
    ],
  },
  'op.boolean': {
    title: 'Булеан',
    group: 'операция',
    inputs: [geo('a', 'A'), geo('b', 'B')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      {
        key: 'operation',
        label: 'операция',
        type: 'select',
        options: ['объединение', 'вычитание', 'пересечение'],
      },
    ],
  },
  'op.array': {
    title: 'Массив',
    group: 'операция',
    inputs: [geo('geo', 'геометрия')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      { key: 'count', label: 'копий', type: 'number', min: 1, max: 500, defaultValue: 4 },
      mm('stepX', 'шаг X', 50),
      mm('stepY', 'шаг Y', 50),
      { ...mm('stepZ', 'шаг Z', 50), defaultValue: 3600 },
    ],
  },
  'op.fillet': {
    title: 'Скругление',
    group: 'операция',
    inputs: [geo('geo', 'геометрия')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      { ...mm('radius', 'радиус', 1), defaultValue: 10 },
      { key: 'allEdges', label: 'все рёбра', type: 'boolean', defaultValue: true },
    ],
  },
  'op.transform': {
    title: 'Трансформ',
    group: 'операция',
    inputs: [geo('geo', 'геометрия'), par('xf', 'матрица')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      mm('moveX', 'сдвиг X', 25),
      mm('moveY', 'сдвиг Y', 25),
      mm('moveZ', 'сдвиг Z', 25),
      { key: 'rotZ', label: 'поворот Z', type: 'number', unit: '°', min: -360, max: 360 },
    ],
  },
  'check.discipline': {
    title: 'Дисциплина',
    group: 'проверка',
    inputs: [geo('geo', 'геометрия')],
    outputs: [geo('geo', 'геометрия')],
    params: [
      { key: 'watertight', label: 'замкнутость', type: 'boolean', defaultValue: true },
      { key: 'collisions', label: 'коллизии', type: 'boolean', defaultValue: true },
      { key: 'norms', label: 'нормы', type: 'boolean', defaultValue: true },
    ],
  },
  'output.export': {
    title: 'Экспорт',
    group: 'выход',
    inputs: [geo('geo', 'геометрия')],
    outputs: [],
    params: [
      {
        key: 'format',
        label: 'формат',
        type: 'select',
        options: ['3dm', 'skp', 'fbx', 'obj', 'glb', 'stl', 'step'],
      },
      { key: 'group', label: 'группировать', type: 'boolean' },
    ],
  },
}

export const NODE_ORDER = Object.keys(NODE_KINDS) as NodeKind[]

/** Форма глифа порта — вместо цветовой кодировки. */
export const PORT_SHAPE: Record<PortType, string> = {
  geometry: 'geo',
  params: 'par',
  data: 'dat',
}

/** Стартовые значения настроек нового узла — иначе поля инспектора пустые. */
export function defaultParams(kind: NodeKind): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const spec of NODE_KINDS[kind].params) {
    if (spec.defaultValue !== undefined) out[spec.key] = spec.defaultValue
    else if (spec.type === 'boolean') out[spec.key] = false
    else if (spec.type === 'select') out[spec.key] = spec.options?.[0] ?? ''
    else if (spec.type === 'number') out[spec.key] = spec.min ?? 0
    else out[spec.key] = ''
  }
  return out
}

/**
 * Можно ли соединить порты. Типы обязаны совпадать: геометрия не лезет в
 * параметры, данные не лезут в геометрию.
 */
export function portsCompatible(from: PortType | undefined, to: PortType | undefined): boolean {
  return from != null && to != null && from === to
}
