import { fill, rhinoScript } from './scripts.ts'
import { VECTOR, type ToolDef } from './types.ts'

/**
 * Инструменты Rhino поверх стороннего плагина rhinomcp
 * (github.com/jingcheng-chen/rhinomcp, MIT). Мы его не форкаем: он ставится
 * как обычный плагин Rhino, а агент говорит с его сокетом на 127.0.0.1:1999.
 *
 * Почему набор написан руками, а не собран из contracts/ самого rhinomcp.
 * Там 40+ команд, и вываливать их все модели — платить токенами на каждом
 * ходу разговора за то, чем пользуются раз в месяц. Вместо этого здесь дюжина
 * ходовых операций с описаниями на русском и в миллиметрах, а полный список
 * доступен в рантайме: rh_list_commands показывает всё, что умеет плагин,
 * rh_command вызывает любую из них по имени. Ни одна возможность не потеряна,
 * но за редкие мы платим только когда они нужны.
 *
 * ЕДИНИЦЫ. У документа Rhino единица произвольная. Инструменты публикуются
 * только если документ в миллиметрах — проверка живёт в реестре, здесь её нет.
 */

export const RHINO_TOOLS: ToolDef[] = [
  {
    name: 'rh_document_summary',
    engine: 'rhino',
    command: 'get_document_summary',
    description:
      'Сводка по открытому документу: объекты, слои, единицы. ' +
      'С неё стоит начинать, чтобы не строить вслепую.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'rh_get_objects',
    engine: 'rhino',
    command: 'get_objects',
    description: 'Список объектов документа с их идентификаторами, типами и слоями.',
    parameters: {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          description: 'Необязательный отбор, например по слою или типу',
        },
      },
    },
  },
  {
    name: 'rh_get_selected',
    engine: 'rhino',
    command: 'get_selected_objects_info',
    description:
      'Что выделено в Rhino прямо сейчас. Полезно, когда пользователь говорит «вот это подвинь».',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'rh_create_object',
    engine: 'rhino',
    command: 'create_object',
    description:
      'Создаёт объект: POINT, LINE, POLYLINE, CIRCLE, ARC, ELLIPSE, CURVE, BOX, SPHERE, CONE, CYLINDER, SURFACE. ' +
      'Геометрические параметры зависят от типа и передаются в params. Все длины в миллиметрах.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'POINT',
            'LINE',
            'POLYLINE',
            'CIRCLE',
            'ARC',
            'ELLIPSE',
            'CURVE',
            'BOX',
            'SPHERE',
            'CONE',
            'CYLINDER',
            'SURFACE',
          ],
        },
        name: { type: 'string' },
        params: {
          type: 'object',
          description: 'Параметры формы: для BOX это width/length/height, для SPHERE radius и так далее',
        },
        translation: VECTOR,
        rotation: { ...VECTOR, description: 'Поворот [x, y, z] в радианах' },
        scale: VECTOR,
        color: {
          type: 'array',
          description: 'Цвет [r, g, b], 0..255',
          items: { type: 'integer' },
          minItems: 3,
          maxItems: 3,
        },
      },
      required: ['type', 'params'],
    },
  },
  {
    name: 'rh_create_objects',
    engine: 'rhino',
    command: 'create_objects',
    description:
      'Создаёт СРАЗУ НЕСКОЛЬКО объектов одним вызовом. Предпочитай его одиночному: пять полок ' +
      'одним вызовом вместо пяти — это пять кругов разговора экономии и меньше поводов ошибиться ' +
      'на полпути. Каждый элемент описывается так же, как в rh_create_object.',
    parameters: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          description: 'Список объектов: у каждого type, name, params и при нужде translation',
          items: { type: 'object' },
        },
      },
      required: ['objects'],
    },
  },
  {
    name: 'rh_delete_object',
    engine: 'rhino',
    command: 'delete_object',
    description: 'Удаляет объект по идентификатору.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Идентификатор объекта' } },
      required: ['id'],
    },
  },
  {
    name: 'rh_extrude_curve',
    engine: 'rhino',
    command: 'extrude_curve',
    description: 'Выдавливает кривую в поверхность или тело. Высота в миллиметрах.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Идентификатор кривой' },
        direction: VECTOR,
        distance: { type: 'number', description: 'Высота выдавливания, мм' },
        cap: { type: 'boolean', description: 'Замкнуть торцы, получив тело' },
      },
      required: ['id'],
    },
  },
  {
    name: 'rh_boolean',
    engine: 'rhino',
    command: 'boolean_union',
    description:
      'Булева операция над телами. Вид задаётся параметром operation: ' +
      'union — объединение, difference — вычитание, intersection — пересечение.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['union', 'difference', 'intersection'] },
        target_ids: {
          type: 'array',
          description: 'Идентификаторы целевых тел',
          items: { type: 'string' },
        },
        tool_ids: {
          type: 'array',
          description: 'Идентификаторы тел-инструментов (для difference и intersection)',
          items: { type: 'string' },
        },
        dry_run: {
          type: 'boolean',
          description: 'Только проверить выполнимость, ничего не меняя',
        },
      },
      required: ['operation', 'target_ids'],
    },
    // У rhinomcp три отдельные команды вместо одной с параметром. Модели
    // удобнее один инструмент с перечислением, поэтому имя выбираем здесь,
    // а сам параметр до моста не доходит — он ничего о нём не знает.
    resolveCommand: (args) => `boolean_${String(args.operation ?? 'union')}`,
    mapParams: (args) => {
      const { operation: _drop, ...rest } = args
      return rest
    },
  },
  {
    name: 'rh_layers',
    engine: 'rhino',
    command: 'get_or_set_current_layer',
    description: 'Читает или задаёт текущий слой. Без параметров — возвращает текущий.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Сделать текущим этот слой' } },
    },
  },
  {
    name: 'rh_create_layer',
    engine: 'rhino',
    command: 'create_layer',
    description:
      'Создаёт слой. По правилу проекта слои называются по материалу: кирпич, стекло, бетон, дерево.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        color: {
          type: 'array',
          description: 'Цвет [r, g, b], 0..255',
          items: { type: 'integer' },
          minItems: 3,
          maxItems: 3,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'rh_inspect',
    engine: 'rhino',
    command: 'execute_rhinoscript_python_code',
    description:
      'Разбор сборки ОДНИМ ответом: по каждой детали габарит, положение, замкнутость и объём, ' +
      'общий габарит, и главное — СТЫКИ: какие детали действительно соприкасаются, а какие лишь ' +
      'перекрываются габаритами, но висят в воздухе. Это самая частая и самая незаметная ошибка ' +
      'сборки. Вызывай вместо нескольких замеров подряд.',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Только этот слой' },
        ids: { type: 'array', description: 'Только эти объекты', items: { type: 'string' } },
        contacts: { type: 'boolean', description: 'Считать стыки; по умолчанию да' },
      },
    },
    mapParams: (args) => ({
      code: fill(rhinoScript('inspect.py'), {
        IDS: args.ids,
        LAYER: args.layer,
        CONTACTS: args.contacts !== false,
      }),
    }),
  },
  {
    name: 'rh_look',
    engine: 'rhino',
    command: 'capture_viewport',
    // Камера наводится сама, до снимка. Вид Rhino остаётся там, где его оставил
    // человек, и построенное запросто оказывается за краем кадра — модель уже
    // посмотрела на пустоту и честно доложила, что сцена пуста. Отдельным
    // инструментом наведение стоило бы лишнего круга на каждый взгляд, а на
    // шуруповёрте четыре взгляда съели восемь кругов из двадцати.
    preCommand: {
      command: 'execute_rhinoscript_python_code',
      params: {
        code: ['import rhinoscriptsyntax as rs', 'rs.ZoomExtents(all=True)'].join('\n'),
      },
    },
    description:
      'Посмотреть на модель: камера наводится на всю геометрию и снимается кадр. ' +
      'Картинка возвращается тебе, и ты её ВИДИШЬ. ' +
      'Проверяй глазами после каждой заметной правки — габарит сходится и у вывернутой детали.',
    parameters: {
      type: 'object',
      properties: {
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
    },
  },
  {
    name: 'rh_list_commands',
    engine: 'rhino',
    command: 'get_commands',
    description:
      'Полный список команд, которые умеет плагин Rhino, с их параметрами. ' +
      'Нужен, когда готового инструмента здесь нет: посмотри список, затем вызови rh_command.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'rh_command',
    engine: 'rhino',
    command: '__dynamic__',
    description:
      'Вызывает любую команду плагина Rhino по имени. Имена и параметры смотри через rh_list_commands. ' +
      'Через неё доступен и авторинг Grasshopper: gh_add_component, gh_connect и прочие.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Имя команды плагина' },
        params: { type: 'object', description: 'Параметры команды' },
      },
      required: ['command'],
    },
    // Имя команды выбирает сама модель — в этом весь смысл инструмента.
    resolveCommand: (args) => String(args.command ?? ''),
    mapParams: (args) => (args.params as Record<string, unknown>) ?? {},
  },
  {
    name: 'rh_discipline_report',
    engine: 'rhino',
    command: 'execute_rhinoscript_python_code',
    description:
      'Проверка модели перед тем, как объявить работу законченной: сколько объектов, ' +
      'все ли тела замкнуты, не проникают ли детали друг в друга, какие вышли габариты ' +
      'и пропорции. Вызывай это, прежде чем сказать пользователю «готово».',
    parameters: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Проверить только этот слой' },
        ids: {
          type: 'array',
          description: 'Проверить только эти объекты',
          items: { type: 'string' },
        },
        anchor: {
          type: 'number',
          description:
            'Известный наибольший габарит, мм. Позволяет поймать ошибку масштаба, ' +
            'которую по одним пропорциям не видно',
        },
      },
    },
    mapParams: (args) => ({
      code: fill(rhinoScript('discipline.py'), {
        LAYER: args.layer,
        IDS: args.ids,
        ANCHOR: args.anchor,
      }),
    }),
  },
  {
    name: 'rh_api_docs',
    engine: 'rhino',
    command: 'execute_rhinoscript_python_code',
    description:
      'Спрашивает у запущенного Rhino настоящую сигнатуру метода — вместо того чтобы ' +
      'угадывать её по памяти. Отвечает по загруженным сборкам, то есть для той версии, ' +
      'что стоит у пользователя. Примеры запроса: rs.AddPipe, Brep.CreatePipe, Brep.CreateFromLoft. ' +
      'Пользуйся перед написанием кода в rh_run_python, если не уверен в аргументах.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Имя функции или метода' },
      },
      required: ['query'],
    },
    mapParams: (args) => ({
      code: fill(rhinoScript('api_docs.py'), { QUERY: args.query }),
    }),
  },
  {
    name: 'rh_run_python',
    engine: 'rhino',
    command: 'execute_rhinoscript_python_code',
    description:
      'Выполняет код RhinoScript/Python внутри Rhino. Через него же запускаются наши доменные ' +
      'скрипты. Единица документа — миллиметр, пересчитывать ничего не надо.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Код Python' } },
      required: ['code'],
    },
  },
]
