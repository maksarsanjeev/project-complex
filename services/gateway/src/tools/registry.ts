import type { EngineDescriptor } from '@complex/protocol'
import { invoke, onlineEngines } from '../agents.ts'
import { BLENDER_TOOLS } from './blender.ts'
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

const ALL: ToolDef[] = [...SKETCHUP_TOOLS, ...RHINO_TOOLS, ...BLENDER_TOOLS]

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
  return instances.some((i) => !i.units || MM_ALIASES.has(i.units.trim().toLowerCase()))
}

/** Инструменты для текущего состояния движков — то, что уйдёт в запрос. */
export function availableTools(): ToolDef[] {
  const usable = new Set(
    onlineEngines()
      .filter(unitsUsable)
      .map((engine) => engine.id),
  )
  // Вопрос пользователю доступен всегда: он не про движок, а про разговор.
  return [ASK_TOOL, ...ALL.filter((tool) => usable.has(tool.engine))]
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
        `${engine.label}${where} запущен, но документ не в миллиметрах: ${windows || 'нет окон'}. ` +
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
    const result = await invoke({ engine: tool.engine, instance, command, params })

    // Снимок вьюпорта приходит в base64 внутри ответа. В переписку с моделью
    // он идёт картинкой, а в текст результата — только сведения о нём: иначе
    // мегабайт base64 осел бы в истории и в базе.
    const shot = result as { base64?: string; mime?: string; width?: number; height?: number }
    if (shot?.base64 && shot.mime?.startsWith('image/')) {
      return {
        ok: true,
        content: `снимок вьюпорта ${shot.width}×${shot.height}`,
        code,
        durationMs: Date.now() - started,
        engine: tool.engine,
        image: { mime: shot.mime, base64: shot.base64 },
      }
    }

    return {
      ok: true,
      content: typeof result === 'string' ? result : JSON.stringify(result),
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
