import type { ToolDef } from './types.ts'

/**
 * Grasshopper — параметрика поверх Rhino.
 *
 * Публикуются НЕ ВСЕГДА, и это осознанно: четырнадцать команд холста стоят
 * токенов на каждом круге, а нужны они далеко не в каждой задаче. Включает их
 * переключатель «Параметрика» у Rhino в панели движков.
 *
 * ЗАПЕКАНИЯ У ПЛАГИНА НЕТ. Среди тридцати его инструментов нет ни одного bake:
 * граф даёт превью, а объектами документа результат сам не становится. Значит
 * после сборки графа геометрию в документ кладёт скрипт — `mc_run_python`, — и
 * отбирать его при включённой параметрике нельзя, иначе работа станет
 * недостижимой.
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
      'Разместить ползунки и компоненты И связать их ОДНИМ вызовом. Основной способ строить граф: ' +
      'по компоненту за раз это сотня кругов на сборку. Ключи (Key) придумываешь сам, ими же ' +
      'ссылаешься в проводах. Selector — лучше Guid из gh_search, имя допустимо, но бывает ' +
      'неоднозначным. X и Y — место на холсте в точках.',
    parameters: {
      type: 'object',
      properties: {
        sliders: {
          type: 'array',
          description:
            'Ползунки: {Key, Min, Value, Max, Type, Name, X, Y}. Type: float | int | even | odd. ' +
            'Name пиши по-русски — это подпись, которую human будет крутить.',
          items: { type: 'object' },
        },
        components: {
          type: 'array',
          description: 'Компоненты: {Key, Selector, X, Y}',
          items: { type: 'object' },
        },
        wires: {
          type: 'array',
          description:
            'Провода: {SrcKey, Src, DstKey, Dst}. Ключи — те, что назначены выше. ' +
            'У параметра-источника (ползунок) имя выхода не принимается: Src: "0" ' +
            'или пустая строка. У обычных компонентов — имя выхода.',
          items: { type: 'object' },
        },
        solve: { type: 'boolean', description: 'Пересчитать холст в конце' },
      },
      required: ['sliders', 'components', 'wires'],
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
