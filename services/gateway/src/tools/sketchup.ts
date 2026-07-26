import { POINT_MM, VECTOR, type ToolDef } from './types.ts'

/**
 * Инструменты SketchUp. Ложатся на маршруты нашего же моста
 * (engines/sketchup/sketchup_mcp_server.rb), поэтому имена параметров здесь
 * ровно те, что мост читает из тела запроса — без переименований.
 *
 * Все длины снаружи в миллиметрах: мост переводит их в дюймы сам, и это
 * единственное место, где перевод происходит.
 *
 * Набор намеренно неполный. У моста 26 команд, но вываливать все в каждый
 * запрос — платить за них токенами на каждом ходу разговора. Здесь то, чем
 * действительно моделят, а редкое доступно через su_run_ruby.
 */

const LAYER = {
  type: 'string' as const,
  description: 'Слой. По принятому в проекте правилу называется по материалу: кирпич, стекло, бетон, дерево',
}

export const SKETCHUP_TOOLS: ToolDef[] = [
  {
    name: 'su_model_info',
    engine: 'sketchup',
    command: 'GET /model/info',
    description:
      'Сведения об открытой модели: имя, путь, единицы, сколько сущностей, слоёв и материалов. ' +
      'Стоит вызвать перед первой правкой, чтобы понять, с чем работаешь.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'su_list_entities',
    engine: 'sketchup',
    command: 'GET /model/entities',
    description:
      'Перечисляет объекты модели с их числовыми id, типами и слоями. ' +
      'Идентификаторы отсюда нужны всем операциям правки — вытягивания, булевых, фасок.',
    parameters: {
      type: 'object',
      properties: {
        group_name: { type: 'string', description: 'Заглянуть внутрь группы с этим именем' },
      },
    },
  },
  {
    name: 'su_create_box',
    engine: 'sketchup',
    command: 'POST /geometry/box',
    description: 'Строит параллелепипед-группу. Габариты в миллиметрах.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Размер по X, мм' },
        depth: { type: 'number', description: 'Размер по Y, мм' },
        height: { type: 'number', description: 'Размер по Z, мм' },
        origin: POINT_MM,
        name: { type: 'string', description: 'Имя группы' },
        layer: LAYER,
        material: { type: 'string', description: 'Имя материала' },
      },
      required: ['width', 'depth', 'height'],
    },
  },
  {
    name: 'su_create_face',
    engine: 'sketchup',
    command: 'POST /geometry/face',
    description: 'Создаёт плоскую грань по контуру точек. Минимум три точки, координаты в мм.',
    parameters: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          description: 'Контур: массив точек [x, y, z] в миллиметрах',
          items: POINT_MM,
          minItems: 3,
        },
        layer: LAYER,
        material: { type: 'string' },
      },
      required: ['points'],
    },
  },
  {
    name: 'su_push_pull',
    engine: 'sketchup',
    command: 'POST /geometry/pushpull',
    description:
      'Вытягивает грань на заданное расстояние в миллиметрах. Отрицательное значение — вдавливает. ' +
      'entity_id должен принадлежать именно грани, его берут из su_list_entities.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'integer', description: 'Числовой id грани' },
        distance: { type: 'number', description: 'Расстояние, мм' },
      },
      required: ['entity_id', 'distance'],
    },
  },
  {
    name: 'su_create_circle',
    engine: 'sketchup',
    command: 'POST /geometry/circle',
    description: 'Окружность из рёбер. Радиус в миллиметрах.',
    parameters: {
      type: 'object',
      properties: {
        center: POINT_MM,
        radius: { type: 'number', description: 'Радиус, мм' },
        normal: VECTOR,
        segments: { type: 'integer', description: 'Число сегментов, по умолчанию 24' },
        layer: LAYER,
      },
      required: ['radius'],
    },
  },
  {
    name: 'su_move',
    engine: 'sketchup',
    command: 'POST /transform/move',
    description: 'Сдвигает объект на вектор. Составляющие вектора — в миллиметрах.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'integer' },
        vector: {
          type: 'array',
          description: 'Смещение [x, y, z] в миллиметрах',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
        },
      },
      required: ['entity_id', 'vector'],
    },
  },
  {
    name: 'su_rotate',
    engine: 'sketchup',
    command: 'POST /transform/rotate',
    description: 'Поворачивает объект вокруг оси. Угол в градусах, точка оси — в миллиметрах.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'integer' },
        axis_point: POINT_MM,
        axis_vector: VECTOR,
        angle: { type: 'number', description: 'Угол, градусы' },
      },
      required: ['entity_id', 'axis_point', 'axis_vector', 'angle'],
    },
  },
  {
    name: 'su_boolean',
    engine: 'sketchup',
    command: 'POST /operations/boolean',
    description:
      'Булева операция над двумя телами: union — объединение, difference — цель минус инструмент, ' +
      'intersection — пересечение. Оба объекта должны быть замкнутыми телами. ' +
      'Работает на копиях, оригиналы остаются, если не задано delete_originals.',
    parameters: {
      type: 'object',
      properties: {
        target_id: { type: 'integer', description: 'Цель операции' },
        tool_id: { type: 'integer', description: 'Инструмент операции' },
        operation: {
          type: 'string',
          enum: ['union', 'difference', 'intersection'],
        },
        delete_originals: { type: 'boolean', description: 'Удалить исходные тела' },
      },
      required: ['target_id', 'tool_id', 'operation'],
    },
  },
  {
    name: 'su_chamfer',
    engine: 'sketchup',
    command: 'POST /operations/chamfer',
    description:
      'Снимает фаску с рёбер тела. Ширина в миллиметрах. ' +
      'Без edge_indices обрабатываются все рёбра — учти, что в углу, где сходятся три фаски, ' +
      'остаётся незакрытый участок: это известное ограничение.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'integer' },
        distance: { type: 'number', description: 'Ширина фаски, мм' },
        edge_indices: {
          type: 'array',
          description: 'Порядковые номера рёбер; без них — все рёбра',
          items: { type: 'integer' },
        },
      },
      required: ['entity_id', 'distance'],
    },
  },
  {
    name: 'su_fillet',
    engine: 'sketchup',
    command: 'POST /operations/fillet',
    description:
      'Скругляет рёбра тела. Радиус в миллиметрах. Ограничение по углам — как у фаски.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'integer' },
        radius: { type: 'number', description: 'Радиус скругления, мм' },
        segments: { type: 'integer', description: 'Гладкость дуги, по умолчанию 8' },
        edge_indices: {
          type: 'array',
          description: 'Порядковые номера рёбер; без них — все рёбра',
          items: { type: 'integer' },
        },
      },
      required: ['entity_id', 'radius'],
    },
  },
  {
    name: 'su_delete',
    engine: 'sketchup',
    command: 'POST /model/delete',
    description:
      'Удаляет объекты по идентификаторам. Возвращает список удалённого и — что важнее — ' +
      'список тех, кто после удаления всё ещё находится в модели: если он не пуст, удаление не удалось.',
    parameters: {
      type: 'object',
      properties: {
        entity_ids: {
          type: 'array',
          description: 'Числовые id объектов',
          items: { type: 'integer' },
        },
      },
      required: ['entity_ids'],
    },
  },
  {
    name: 'su_undo',
    engine: 'sketchup',
    command: 'POST /model/undo',
    description:
      'Отменяет последнюю операцию в SketchUp — ровно одну. Каждый вызов инструмента правки ' +
      'создаёт одну операцию, поэтому одна отмена откатывает один твой шаг.\n' +
      'ВНИМАНИЕ: отмена возвращает объект, но НЕ гарантирует, что он встанет ровно туда, где был, ' +
      'если между делом были другие правки. Всегда перечитывай результат и сверяй с ожиданием, ' +
      'а не докладывай об успехе по факту вызова.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'su_get_selection',
    engine: 'sketchup',
    command: 'GET /model/selection',
    description:
      'Что выделено в самом SketchUp сейчас. Выделение из веб-морды приходит отдельно, ' +
      'в описании задачи, — этот инструмент нужен, когда человек выделял мышью в приложении.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'su_set_selection',
    engine: 'sketchup',
    command: 'POST /model/selection',
    description:
      'Выделяет объекты в SketchUp — чтобы человек увидел на экране приложения то, о чём идёт речь. ' +
      'Полезно, когда объектов много и нужно показать, какие именно ты имеешь в виду.',
    parameters: {
      type: 'object',
      properties: {
        entity_ids: {
          type: 'array',
          description: 'Числовые id объектов; пустой список снимает выделение',
          items: { type: 'integer' },
        },
      },
      required: ['entity_ids'],
    },
  },
  {
    name: 'su_run_ruby',
    engine: 'sketchup',
    command: 'POST /ruby/execute',
    description:
      'Выполняет произвольный код Ruby в SketchUp — на случай, когда готового инструмента нет. ' +
      'Помни: внутренняя единица SketchUp — дюйм, поэтому миллиметры дели на 25.4. ' +
      'Оборачивай правки в start_operation / commit_operation, иначе отмена сработает не целиком.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Код Ruby' },
      },
      required: ['code'],
    },
  },
]
