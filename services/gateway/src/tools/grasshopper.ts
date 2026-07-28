import type { ToolDef } from './types.ts'

/**
 * Grasshopper — параметрика поверх Rhino.
 *
 * Публикуются НЕ ВСЕГДА, и это осознанно: четырнадцать команд холста стоят
 * токенов на каждом круге, а нужны они далеко не в каждой задаче. Включает их
 * переключатель «Параметрика» у Rhino в панели движков.
 *
 * Чего эти инструменты НЕ умеют, и об этом лучше знать заранее: сделать
 * параметрической уже построенную деталь. Тело, созданное скриптом, истории не
 * имеет, и граф его не подхватит — Grasshopper геометрию не редактирует, он её
 * порождает. Поэтому параметрику решают ДО постройки, а не после.
 */
export const GRASSHOPPER_TOOLS: ToolDef[] = [
  {
    name: 'gh_start',
    engine: 'rhino',
    command: 'mc:g1_start',
    description: 'Запускает Grasshopper. Нужен один раз перед работой с холстом.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'gh_canvas',
    engine: 'rhino',
    command: 'mc:g1_get_canvas_graph',
    description:
      'Состояние холста: компоненты с их сообщениями, входы и выходы, связи. ' +
      'Холст ты не видишь глазами — это единственный способ понять, что на нём.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'gh_search',
    engine: 'rhino',
    command: 'mc:g1_search_components',
    description: 'Поиск компонента в библиотеке по части имени. Имена не угадывай — ищи.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Часть имени или описания' } },
      required: ['query'],
    },
  },
  {
    name: 'gh_describe',
    engine: 'rhino',
    command: 'mc:g1_describe_component',
    description: 'Категория, описание и список входов-выходов компонента — перед тем как его связывать.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Имя компонента' } },
      required: ['name'],
    },
  },
  {
    name: 'gh_apply_graph',
    engine: 'rhino',
    command: 'mc:g1_apply_graph',
    description:
      'Разместить компоненты и ползунки И связать их ОДНИМ вызовом. Основной способ строить граф: ' +
      'по компоненту за вызов — это сотня кругов на сборку, здесь весь граф за один. ' +
      'Ссылки между объектами задаются именами, которые ты сам назначил.',
    parameters: {
      type: 'object',
      properties: {
        graph: {
          type: 'object',
          description: 'Описание графа: объекты и связи между ними',
        },
      },
      required: ['graph'],
    },
  },
  {
    name: 'gh_place_slider',
    engine: 'rhino',
    command: 'mc:g1_place_slider',
    description: 'Поставить отдельный ползунок с диапазоном и текущим значением.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Подпись ползунка — по-русски, понятная человеку' },
        min: { type: 'number', description: 'Минимум' },
        max: { type: 'number', description: 'Максимум' },
        value: { type: 'number', description: 'Текущее значение' },
      },
      required: ['name', 'min', 'max', 'value'],
    },
  },
  {
    name: 'gh_connect_many',
    engine: 'rhino',
    command: 'mc:g1_connect_many',
    description: 'Соединить несколько выходов со входами за один вызов.',
    parameters: {
      type: 'object',
      properties: {
        links: { type: 'array', description: 'Связи «источник → приёмник»', items: { type: 'object' } },
      },
      required: ['links'],
    },
  },
  {
    name: 'gh_solve',
    engine: 'rhino',
    command: 'mc:g1_solve_graph',
    description: 'Пересчитать холст. После этого смотри результат обычным mc_look.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'gh_clear',
    engine: 'rhino',
    command: 'mc:g1_clear_canvas',
    description:
      'Стереть холст целиком. Разрушающая операция — спроси человека, прежде чем звать, ' +
      'если на холсте есть чужая работа.',
    parameters: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Обязательно true' } },
      required: ['confirm'],
    },
  },
]
