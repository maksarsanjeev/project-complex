import type { ToolDef } from './types.ts'

/**
 * Инструменты Blender поверх стороннего аддона blender-mcp
 * (github.com/ahujasid/blender-mcp, MIT). Аддон ставится как обычный, агент
 * говорит с его сокетом на 127.0.0.1:9876.
 *
 * Честная оговорка про возможности. У аддона всего четыре содержательные
 * команды: сведения о сцене, сведения об объекте, снимок вида и выполнение
 * кода. Типизированных операций вроде «создай куб» там нет — вся геометрия
 * идёт через Python. Поэтому набор здесь короткий, и это не упущение, а
 * отражение того, что аддон умеет.
 *
 * ЕДИНИЦЫ — главная ловушка. Внутренняя единица Blender метр, а у нас всё в
 * миллиметрах. Расхождение в тысячу раз выглядит как «модель куда-то пропала»
 * при первом же взгляде во вьюпорт. Правило вынесено в описание bl_run_python,
 * потому что именно там пишется код, и напоминание должно быть перед глазами
 * в момент написания, а не в отдельной документации.
 */

export const BLENDER_TOOLS: ToolDef[] = [
  {
    name: 'bl_scene_info',
    engine: 'blender',
    command: 'get_scene_info',
    description: 'Сведения о сцене: объекты, коллекции, материалы, текущее состояние.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'bl_object_info',
    engine: 'blender',
    command: 'get_object_info',
    description: 'Подробности об объекте: положение, габариты, модификаторы, материалы.',
    parameters: {
      type: 'object',
      properties: { object_name: { type: 'string', description: 'Имя объекта в сцене' } },
      required: ['object_name'],
    },
  },
  {
    name: 'bl_viewport_screenshot',
    engine: 'blender',
    command: 'get_viewport_screenshot',
    description: 'Снимок вида — посмотреть на результат глазами, а не по цифрам.',
    parameters: {
      type: 'object',
      properties: { max_size: { type: 'integer', description: 'Наибольшая сторона, пикселей' } },
    },
  },
  {
    name: 'bl_run_python',
    engine: 'blender',
    command: 'execute_code',
    description:
      'Выполняет код Python внутри Blender. Через него делается вся геометрия — своих команд ' +
      'построения у аддона нет.\n' +
      'ВАЖНО ПРО ЕДИНИЦЫ: внутренняя единица Blender — метр, а весь пайплайн проекта в ' +
      'миллиметрах. Каждый размер дели на 1000. Куб 1000 мм — это size=1.0, а не 1000.0, ' +
      'иначе объект окажется размером с километр.\n' +
      'Модуль bpy уже доступен, импортировать его не нужно.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Код Python' } },
      required: ['code'],
    },
  },
]
