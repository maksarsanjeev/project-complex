import type { GraphPort, NodeKind, PortType } from '@complex/protocol'

interface KindSpec {
  title: string
  /** Группа в палитре узлов. */
  group: 'вход' | 'знание' | 'агент' | 'движок' | 'операция' | 'проверка' | 'выход'
  inputs: GraphPort[]
  outputs: GraphPort[]
}

const geo = (id: string, name: string): GraphPort => ({ id, name, type: 'geometry' })
const par = (id: string, name: string): GraphPort => ({ id, name, type: 'params' })
const dat = (id: string, name: string): GraphPort => ({ id, name, type: 'data' })

/** Описание типов узлов: заголовок, группа палитры, набор портов. */
export const NODE_KINDS: Record<NodeKind, KindSpec> = {
  'input.prompt': { title: 'Промпт', group: 'вход', inputs: [], outputs: [dat('out', 'текст')] },
  'input.image': { title: 'Референс', group: 'вход', inputs: [], outputs: [dat('out', 'изобр')] },
  'input.reference': {
    title: 'Образец',
    group: 'вход',
    inputs: [],
    outputs: [geo('out', 'геометрия')],
  },
  'kb.query': {
    title: 'База знаний',
    group: 'знание',
    inputs: [dat('q', 'запрос')],
    outputs: [dat('ctx', 'контекст')],
  },
  'agent.llm': {
    title: 'Агент',
    group: 'агент',
    inputs: [dat('prompt', 'промпт'), dat('ctx', 'контекст')],
    outputs: [par('plan', 'план')],
  },
  'engine.sketchup': {
    title: 'SketchUp',
    group: 'движок',
    inputs: [par('plan', 'план')],
    outputs: [geo('geo', 'геометрия')],
  },
  'engine.blender': {
    title: 'Blender',
    group: 'движок',
    inputs: [par('plan', 'план')],
    outputs: [geo('geo', 'геометрия')],
  },
  'engine.rhino': {
    title: 'Rhino',
    group: 'движок',
    inputs: [par('plan', 'план')],
    outputs: [geo('geo', 'геометрия')],
  },
  'op.boolean': {
    title: 'Булеан',
    group: 'операция',
    inputs: [geo('a', 'A'), geo('b', 'B')],
    outputs: [geo('geo', 'геометрия')],
  },
  'op.array': {
    title: 'Массив',
    group: 'операция',
    inputs: [geo('geo', 'геометрия')],
    outputs: [geo('geo', 'геометрия')],
  },
  'op.fillet': {
    title: 'Скругление',
    group: 'операция',
    inputs: [geo('geo', 'геометрия')],
    outputs: [geo('geo', 'геометрия')],
  },
  'op.transform': {
    title: 'Трансформ',
    group: 'операция',
    inputs: [geo('geo', 'геометрия'), par('xf', 'матрица')],
    outputs: [geo('geo', 'геометрия')],
  },
  'check.discipline': {
    title: 'Дисциплина',
    group: 'проверка',
    inputs: [geo('geo', 'геометрия')],
    outputs: [geo('geo', 'геометрия')],
  },
  'output.export': {
    title: 'Экспорт',
    group: 'выход',
    inputs: [geo('geo', 'геометрия')],
    outputs: [],
  },
}

export const NODE_ORDER = Object.keys(NODE_KINDS) as NodeKind[]

/** Форма глифа порта — вместо цветовой кодировки. */
export const PORT_SHAPE: Record<PortType, string> = {
  geometry: 'geo',
  params: 'par',
  data: 'dat',
}
