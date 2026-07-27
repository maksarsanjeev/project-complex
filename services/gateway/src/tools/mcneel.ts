import type { ToolDef } from './types.ts'

/**
 * Инструменты официального моста McNeel RhinoMCP.
 *
 * Стоят рядом с инструментами jingcheng, а не вместо них, и различаются
 * приставкой имени: `rh_` — сокетный мост jingcheng, `mc_` — HTTP-мост McNeel.
 * Это сделано ради честного сравнения: оба живут в одном Rhino, и один сеанс
 * может пользоваться то тем, то другим.
 *
 * Главное различие видно прямо в этом списке. У jingcheng есть типизированное
 * построение — `create_objects` пакетом, `dry_run` у булевых операций. Здесь
 * геометрии нет вовсе: всё, что строит, строится скриптом. Зато канал чище
 * (один конверт вместо двойной печати), Python третий, а `mc_context` отдаёт
 * состояние документа за один заход, где раньше уходило три вызова.
 *
 * Grasshopper сюда намеренно не вынесен: у McNeel четырнадцать команд холста,
 * и вываливать их все в подсказку ради проверки шуруповёрта — значит платить
 * токенами за то, чем сейчас не пользуемся.
 */
export const MCNEEL_TOOLS: ToolDef[] = [
  {
    name: 'mc_run_python',
    engine: 'rhino',
    command: 'mc:run_python',
    description:
      'Выполняет Python 3 в Rhino через официальный мост McNeel. Основной способ строить: ' +
      'типизированных инструментов создания у этого моста нет. Единица документа — миллиметр. ' +
      'Печатай результат — вернётся напечатанное.',
    parameters: {
      type: 'object',
      properties: { script: { type: 'string', description: 'Код Python 3' } },
      required: ['script'],
    },
  },
  {
    name: 'mc_run_command',
    engine: 'rhino',
    command: 'mc:run_command',
    description:
      'Выполняет команду Rhino строкой, как в командной строке приложения, и возвращает её вывод. ' +
      'Пример: "_Box 0,0,0 10 10 10". Годится там, где команда короче скрипта.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Строка команды Rhino' } },
      required: ['command'],
    },
  },
  {
    name: 'mc_context',
    engine: 'rhino',
    command: 'mc:get_context',
    description:
      'Состояние документа за один вызов: что выделено, где камера, сколько объектов и слоёв, ' +
      'открыт ли Grasshopper. С этого стоит начинать — дешевле, чем три отдельных запроса.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mc_list_objects',
    engine: 'rhino',
    command: 'mc:list_objects',
    description:
      'Объекты документа с фильтром по имени, слою или типу геометрии. Только чтение — ' +
      'ничего не меняет. Отсюда берутся идентификаторы для правки: угадать их нельзя.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Фильтр по имени' },
        layer: { type: 'string', description: 'Полный путь слоя' },
        type: { type: 'string', description: 'Тип геометрии' },
      },
    },
  },
  {
    name: 'mc_look',
    engine: 'rhino',
    command: 'mc:get_viewport_image',
    description:
      'Снимок активного вида — ты его действительно видишь. Вызывай после каждой правки формы ' +
      'и честно оценивай результат: расчёт по числам не заменяет взгляда.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'integer', description: 'Ширина кадра, точек' },
        height: { type: 'integer', description: 'Высота кадра, точек' },
      },
    },
  },
  {
    name: 'mc_zoom_to_object',
    engine: 'rhino',
    command: 'mc:zoom_to_object',
    description: 'Наводит вид на объекты по их идентификаторам — чтобы снимок показал нужное.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          description: 'Идентификаторы объектов',
          items: { type: 'string' },
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'mc_set_selection',
    engine: 'rhino',
    command: 'mc:set_selection',
    description:
      'Выделяет объекты по фильтру (идентификаторы, имена, слой, тип). Прежнее выделение снимается.',
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'array', description: 'Идентификаторы', items: { type: 'string' } },
        name: { type: 'string', description: 'Фильтр по имени' },
        layer: { type: 'string', description: 'Полный путь слоя' },
      },
    },
  },
]
