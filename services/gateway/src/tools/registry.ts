import { config } from '../config.ts'
import type { EngineDescriptor } from '@complex/protocol'
import { invoke, onlineEngines } from '../agents.ts'
import { BLENDER_TOOLS } from './blender.ts'
import { ITERATION_TOOL } from './iteration.ts'
import { MCNEEL_TOOLS } from './mcneel.ts'
import { RHINO_TOOLS } from './rhino.ts'
import { ASK_TOOL } from './ask.ts'
import { SKETCHUP_TOOLS } from './sketchup.ts'
import type { ToolDef } from './types.ts'

/**
 * Что из инструментов показывать модели.
 *
 * Список ДИНАМИЧЕСКИЙ: уходят только те инструменты, чей движок сейчас
 * действительно запущен. Причина не в экономии токенов, а в честности. Если
 * показать модели su_create_box при закрытом SketchUp, она его вызовет,
 * получит ошибку и в лучшем случае перескажет её пользователю. Когда
 * инструмента нет вовсе, ответ получается правильный сам собой: «запусти
 * SketchUp, тогда построю».
 */

const ALL: ToolDef[] = [...SKETCHUP_TOOLS, ...RHINO_TOOLS, ...MCNEEL_TOOLS, ...BLENDER_TOOLS]

/** Имя инструмента-вопроса: цикл разговора обрабатывает его сам, без движка. */
export const ASK_TOOL_NAME = ASK_TOOL.name

const BY_NAME = new Map(ALL.map((tool) => [tool.name, tool]))

/** Формат функции, который ждёт OpenAI-совместимый API. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

/**
 * Единица длины документа считается пригодной, если это миллиметры.
 *
 * Проверка нужна только Rhino: у SketchUp мост переводит сам, у Blender единица
 * всегда метр и деление на 1000 зашито в описание инструмента. А вот документ
 * Rhino бывает в чём угодно, и молча пересчитывать нельзя — пользователь
 * получит модель в чужом масштабе и заметит это позже всех.
 */
const MM_ALIASES = new Set(['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres', 'мм'])

function unitsUsable(engine: EngineDescriptor): boolean {
  if (engine.id !== 'rhino') return true
  const instances = engine.instances ?? []
  if (!instances.length) return false
  // Достаточно одного пригодного документа: вызов уйдёт именно в него.
  //
  // Неизвестные единицы НЕ считаются пригодными. Раньше считались — и проверка,
  // написанная ради защиты от чужого масштаба, пропускала всё подряд, стоило
  // прочитать поле не оттуда. Молчаливое допущение хуже отказа: про отказ
  // человеку скажут, про допущение он узнает по модели в чужом масштабе.
  return instances.some((i) => i.units && MM_ALIASES.has(i.units.trim().toLowerCase()))
}

/**
 * Пропускать ли инструмент при выбранном мосте к Rhino.
 *
 * Двух наборов сразу модель не выдерживает: в одном ходе она мешает `rh_` и
 * `mc_`, а описания обоих оплачиваются на каждом круге. К остальным движкам
 * это отношения не имеет.
 */
function bridgeAllows(tool: ToolDef): boolean {
  if (tool.engine !== 'rhino') return true
  if (config.rhinoBridge === 'both') return true
  const mcneel = tool.name.startsWith('mc_')
  return config.rhinoBridge === 'mcneel' ? mcneel : !mcneel
}

/** Инструменты для текущего состояния движков — то, что уйдёт в запрос. */
export function availableTools(): ToolDef[] {
  const usable = new Set(
    onlineEngines()
      .filter(unitsUsable)
      .map((engine) => engine.id),
  )
  // Вопрос пользователю доступен всегда: он не про движок, а про разговор.
  // Вопрос и конец итерации доступны всегда: они про разговор, а не про движок.
  return [ASK_TOOL, ITERATION_TOOL, ...ALL.filter((t) => usable.has(t.engine) && bridgeAllows(t))]
}

/**
 * Превращает описания в то, что уходит модели, и по дороге дописывает выбор
 * окна там, где он нужен.
 *
 * Почему это здесь, а не в схемах инструментов. Окно выбирается только у
 * SketchUp и только когда их открыто несколько — а это состояние времени
 * выполнения, схемы про него ничего не знают. Прописывать `instance` в каждый
 * из двенадцати инструментов руками значило бы двенадцать раз повторить одно
 * и то же и один раз забыть.
 *
 * Пока окно единственное, параметра нет вовсе: лишнее поле в схеме — это
 * лишний повод модели заполнить его выдумкой.
 */
export function toWireTools(tools: ToolDef[]): WireTool[] {
  const windows = onlineEngines().find((e) => e.id === 'sketchup')?.instances ?? []
  const needsChoice = windows.length > 1

  return tools.map((tool) => {
    if (tool.engine !== 'sketchup' || !needsChoice) {
      return {
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }
    }

    const names = windows.map((w) => `«${w.title}»`).join(', ')
    const active = windows.find((w) => w.active)

    // Поле обязательно только пока человек не выбрал окно кнопкой в SketchUp.
    // Выбрал — требовать нечего: у вызова есть точное умолчание, а назвать
    // другое окно модель по-прежнему может, если её об этом попросили.
    const description = active
      ? `Окно SketchUp, в котором работать. Открыты: ${names}. ` +
        `Не указывай, если пользователь не назвал окно: вызов уйдёт в «${active.title}», ` +
        'которое он сам отметил кнопкой «Окно для ИИ».'
      : `Окно SketchUp, в котором работать. Открыты: ${names}. ` +
        'Пользователь ни одно из них не отметил кнопкой «Окно для ИИ», поэтому укажи имя окна. ' +
        'Если он не сказал, в каком именно, — спроси, а не выбирай сам.'

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          ...tool.parameters,
          properties: {
            ...tool.parameters.properties,
            instance: { type: 'string', description },
          },
          required: active
            ? (tool.parameters.required ?? [])
            : [...(tool.parameters.required ?? []), 'instance'],
        },
      },
    }
  })
}

/**
 * Строки для системной подсказки: что запущено, а что нет и почему.
 * Без них модель, не увидев инструментов, начинает выдумывать причины.
 */
export function engineSummary(): string {
  const engines = onlineEngines()
  if (!engines.length) {
    return (
      'Сейчас ни один движок не подключён, инструментов моделирования нет. ' +
      'Если пользователь просит что-то построить — объясни, что нужно запустить ' +
      'SketchUp, Rhino или Blender с установленным мостом, и не делай вид, что построил.'
    )
  }

  const lines = engines.map((engine) => {
    const where = engine.agent ? ` на машине ${engine.agent}` : ''
    const windows = (engine.instances ?? [])
      .map(
        (i) =>
          `${i.title ?? 'без имени'} (порт ${i.port}${i.units ? `, ${i.units}` : ''}` +
          `${i.active ? ', выбрано пользователем для работы' : ''})`,
      )
      .join('; ')

    if (!unitsUsable(engine)) {
      return (
        `${engine.label}${where} запущен, но единицы документа не миллиметры или не определены: ` +
        `${windows || 'нет окон'}. ` +
        'Инструменты Rhino отключены. Скажи пользователю, что нужно перевести единицы документа ' +
        'в миллиметры, — пересчитывать за него нельзя, модель уйдёт в чужом масштабе.'
      )
    }

    return `${engine.label}${where}: ${windows || 'окон не найдено'}.`
  })

  return `Запущенные движки:\n${lines.join('\n')}`
}

/* ────────────────────────── выполнение ────────────────────────── */

export interface ToolOutcome {
  ok: boolean
  /** Что уйдёт модели: результат или объяснение неудачи. */
  content: string
  /** Что показать пользователю в блоке вызова. */
  code: string
  durationMs: number
  engine: ToolDef['engine']
  /**
   * Картинка, которую модель должна УВИДЕТЬ, а не прочитать описанием.
   *
   * Формат ответа инструмента этого не позволяет: там только текст. Поэтому
   * снимок отправляется следом отдельным сообщением с изображением — так
   * устроены все совместимые с OpenAI интерфейсы.
   */
  image?: { mime: string; base64: string }
}

/**
 * Снимок вьюпорта внутри ответа инструмента.
 *
 * Поле называется по-разному у каждого моста: у нашего SketchUp это
 * `base64` + `mime`, у rhinomcp — `image_data`. Узнавать надо ВСЕ формы, и вот
 * почему это не мелочь: пропущенная картинка попадает в переписку ТЕКСТОМ и
 * пересылается заново на каждом следующем круге инструментов.
 *
 * Измерено на живом стеллаже: один непойманный снимок Rhino раздул ход до
 * 326 527 токенов ввода и 0,70 доллара — вместо примерно пяти тысяч и цента.
 */
function extractImage(
  result: unknown,
): { mime: string; base64: string; note: string } | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>

  const candidates: Array<[unknown, string]> = [
    [r.base64, typeof r.mime === 'string' ? r.mime : 'image/png'],
    [r.image_data, 'image/png'],
    [r.imageData, 'image/png'],
  ]

  for (const [value, mime] of candidates) {
    if (typeof value !== 'string' || value.length < 512) continue
    const size = Math.round((value.length * 3) / 4 / 1024)
    const w = typeof r.width === 'number' ? r.width : undefined
    const h = typeof r.height === 'number' ? r.height : undefined
    return {
      mime,
      base64: value,
      note: `снимок вьюпорта${w && h ? ` ${w}×${h}` : ''}, ${size} КБ — смотри следующим сообщением`,
    }
  }
  return null
}

/**
 * Предохранитель на длину ответа инструмента.
 *
 * Список объектов большой модели или сводка документа тоже бывают на сотни
 * килобайт, и каждый такой ответ остаётся в переписке до конца хода. Обрезаем
 * с честной пометкой: модель должна знать, что видит не всё, а не думать, что
 * объектов ровно столько.
 */
const RESULT_LIMIT = 12_000

function shorten(text: string): string {
  if (text.length <= RESULT_LIMIT) return text
  return (
    text.slice(0, RESULT_LIMIT) +
    `

[…обрезано: ответ ${Math.round(text.length / 1024)} КБ, показано первые ` +
    `${Math.round(RESULT_LIMIT / 1024)} КБ. Запроси нужное точнее — фильтром или по частям.]`
  )
}

/**
 * Выполняет вызов, придуманный моделью. Ошибки НЕ бросает: неудача — это тоже
 * результат, который модель должна прочитать и как-то на него ответить.
 * Брошенное исключение оборвало бы весь ход и оставило пользователя без объяснения.
 */
export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const started = Date.now()
  const tool = BY_NAME.get(name)

  if (!tool) {
    return {
      ok: false,
      content: `инструмента ${name} не существует`,
      code: JSON.stringify(args, null, 2),
      durationMs: 0,
      engine: 'sketchup',
    }
  }

  const params = tool.mapParams ? tool.mapParams(args) : { ...args }
  const command = tool.resolveCommand ? tool.resolveCommand(args) : tool.command
  // Окно приложения выбирает модель; когда окно одно, агент разберётся сам.
  const instance = typeof args.instance === 'string' ? args.instance : undefined
  delete params.instance

  const code = `${command}\n${JSON.stringify(params, null, 2)}`

  try {
    // Предварительная команда: её результат модели не показываем — он служебный.
    // Ошибку тоже глотаем: не навелась камера — снимок всё равно лучше отказа.
    if (tool.preCommand) {
      await invoke({
        engine: tool.engine,
        instance,
        command: tool.preCommand.command,
        params: tool.preCommand.params ?? {},
      }).catch(() => undefined)
    }

    const result = await invoke({ engine: tool.engine, instance, command, params })

    // Картинку вынимаем ДО того, как ответ станет текстом.
    const image = extractImage(result)
    if (image) {
      return {
        ok: true,
        content: image.note,
        code,
        durationMs: Date.now() - started,
        engine: tool.engine,
        image: { mime: image.mime, base64: image.base64 },
      }
    }

    return {
      ok: true,
      content: shorten(typeof result === 'string' ? result : JSON.stringify(result)),
      code,
      durationMs: Date.now() - started,
      engine: tool.engine,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      content: `ошибка: ${message}`,
      code,
      durationMs: Date.now() - started,
      engine: tool.engine,
    }
  }
}
