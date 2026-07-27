import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import type { SelectionRef } from '@complex/protocol'
import * as agents from '../agents.ts'
import { config } from '../config.ts'
import { nowIso } from '../db/db.ts'
import { sessionEngine } from '../db/repo.ts'
import { takeSnapshot } from '../snapshot.ts'
import { ITERATION_TOOL_NAME } from '../tools/iteration.ts'
import {
  ASK_TOOL_NAME,
  availableTools,
  runTool,
  toWireTools,
} from '../tools/registry.ts'
import type { JsonSchema } from '../tools/types.ts'
import { PieceQueue, type LlmPiece } from './piece.ts'
import { toZodShape } from './schema.ts'

/**
 * Модель через Claude Agent SDK — тот же движок, что у Claude Code, только
 * библиотекой внутри нашего процесса.
 *
 * Чем это отличается от пути через OpenRouter, и почему отличие принципиальное.
 * Там мы сами крутим цикл «спросили → выполнили инструмент → спросили снова», и
 * каждый круг — отдельный запрос, который мы собираем руками. Здесь цикл крутит
 * SDK: мы отдаём ему инструменты и подсказку, а он сам решает, что вызвать, сам
 * складывает историю хода и сам кэширует её. Наш `maxToolRounds` превращается в
 * `maxTurns`, а сборка сообщений исчезает вовсе.
 *
 * Что от этого выигрывается, кроме денег:
 *
 *  1. Снимок вьюпорта уходит модели ПРЯМО В ОТВЕТЕ ИНСТРУМЕНТА. В формате
 *     OpenAI картинку в ответ инструмента положить нельзя, и приходится слать
 *     её следом отдельным сообщением от лица пользователя. В MCP же блок
 *     `image` — законная часть ответа. Меньше подлога и меньше токенов.
 *  2. Кэш между ходами. Продолжение сессии через `resume` даёт SDK его
 *     собственный кэш разговора — нам не нужно ни собирать историю, ни ставить
 *     метки кэша руками.
 *
 * ВХОД. Подписочный вход (claude.ai) документация разрешает не для всех
 * применений: сторонним продуктам предлагается ключ API. Поэтому здесь берётся
 * то, что задано в окружении, и никакой вход не зашит: `CLAUDE_CODE_OAUTH_TOKEN`
 * для личного запуска, `ANTHROPIC_API_KEY` для всех остальных. Нет ни того ни
 * другого — провайдер честно помечается ненастроенным.
 */

/** Имя сервера MCP, под которым инструменты видит модель. */
const SERVER = 'complex'

/**
 * Соответствие «наша сессия → сессия SDK».
 *
 * Держим в памяти намеренно. Сессия SDK живёт файлом в контейнере, и после
 * пересборки образа её всё равно нет. Потерялась — следующий ход начнётся с
 * чистого листа и подставленной истории: дороже на один ход, но не сломано.
 */
const sdkSessions = new Map<string, string>()

/** Встроенные инструменты Claude Code нам не нужны и опасны. */
const BUILT_INS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'TodoWrite',
  'KillShell',
  'BashOutput',
]

export function cliConfigured(): boolean {
  return Boolean(config.claudeCodeToken || config.anthropicKey)
}

export async function* runClaudeCode(input: {
  sessionId: string
  text: string
  model: string
  systemPrompt: string
  selection?: SelectionRef[]
}): AsyncGenerator<LlmPiece> {
  // Расход копится по ходу, а не берётся из итогового сообщения: итог придёт
  // слишком поздно, чтобы на него реагировать. Считаем по сообщениям модели —
  // в каждом лежит расход его собственного обращения к API.
  const spent = { prompt: 0, completion: 0, cached: 0 }
  let stoppedByBudget = false
  let lastTool = ''
  /** Чекпойнт за ход бывает один: дальше решает человек. */
  let checkpoint = false
  /**
   * Сколько объектов было в сцене ДО начала хода.
   *
   * Сравнивать с нулём оказалось нельзя: в сцене обычно лежит чужая работа, и
   * страховка срабатывала на ней — на первом же вызове, до того как модель
   * успевала что-либо построить. Показывать человеку чужую модель как
   * «результат прохода» бессмысленно.
   */
  let objectsBefore = -1

  const queue = new PieceQueue()
  const defs = availableTools(sessionEngine(input.sessionId))
  const wire = toWireTools(defs)

  // Инструменты собираем из тех же описаний, что уходят в OpenRouter, включая
  // дописанный на лету выбор окна SketchUp. Один источник правды: разойдись эти
  // два списка — разница вылезла бы только на живой модели.
  const tools = wire.map((item) =>
    tool(
      item.function.name,
      item.function.description,
      toZodShape(item.function.parameters as JsonSchema),
      async (args: Record<string, unknown>) => {
        const id = `call_${Math.random().toString(36).slice(2, 10)}`

        // Вопрос пользователю — не работа с движком, а конец хода. Выполнять
        // его нечем: ответом станет следующее сообщение человека.
        if (item.function.name === ASK_TOOL_NAME) {
          const question = String(args.question ?? '').trim()
          const options = Array.isArray(args.options) ? args.options.map(String) : undefined
          if (question) queue.push({ kind: 'ask', question, options })
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Вопрос задан пользователю. Закончи ход и дождись ответа — ничего не строй.',
              },
            ],
          }
        }

        lastTool = item.function.name
        if (item.function.name === ITERATION_TOOL_NAME) {
          checkpoint = true
          queue.push({ kind: 'ask', question: iterationQuestion(args), options: CHOICES })
          return {
            content: [{ type: 'text' as const, text: 'Проход показан человеку. Закончи ход и жди ответа.' }],
          }
        }

        queue.push({ kind: 'tool-start', id, name: item.function.name, args })
        const outcome = await runTool(item.function.name, args)
        queue.push({ kind: 'tool-done', id, name: item.function.name, outcome })

        // Крючок, не зависящий от дисциплины модели: как только в сцене
        // появилась геометрия, показывать уже есть что. Полагаться на её
        // собственное «готово» нельзя — за один заход она сделала двадцать
        // четыре круга доводки и ни разу не решила, что закончила.
        //
        // Спрашиваем состояние отдельным дешёвым вызовом и только после
        // строящих инструментов: у McNeel `get_context` для того и заведён.
        if (!checkpoint && BUILDING.has(item.function.name)) {
          const now = await objectCount()
          if (objectsBefore < 0 || now < objectsBefore) {
            // Отсчёт ведём от НИЖНЕЙ точки, а не от начала хода. Первым делом
            // модель обычно чистит сцену: если оставить старую отметку, прирост
            // с нуля до тридцати деталей окажется «меньше, чем было», и
            // страховка промолчит — ровно так и вышло на живом ходе.
            objectsBefore = now
          } else if (now > objectsBefore) {
            // Стоп — на приросте, а не на наличии: важно, что модель что-то
            // сделала, а не что в сцене вообще что-то есть.
            checkpoint = true
          }
        }

        // Картинка идёт блоком ответа, а не отдельным сообщением: MCP это
        // умеет, и модель видит снимок ровно там, где просила его сделать.
        const content: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: outcome.content }]
        if (outcome.image) {
          content.push({
            type: 'image',
            data: outcome.image.base64,
            mimeType: outcome.image.mime,
          })
        }
        return { content, isError: !outcome.ok }
      },
      // Подсказки поведения: по ним SDK понимает, какие вызовы безобидны.
      // Читающие инструменты движков не меняют модель — их незачем и
      // придерживать, и переспрашивать про них.
      { annotations: { readOnlyHint: isReadOnly(item.function.name), openWorldHint: false } },
    ),
  )

  const server = createSdkMcpServer({
    name: SERVER,
    version: '0.1.0',
    tools,
    // Все инструменты держим в подсказке целиком. Отложенная выдача сэкономила
    // бы токены, но стоила бы кругов: модель сначала искала бы инструмент, и
    // только потом строила. На геометрии круги дороже описаний.
    alwaysLoad: true,
  })

  const resume = sdkSessions.get(input.sessionId)

  const run = query({
    prompt: input.text,
    options: {
      model: input.model,
      systemPrompt: input.systemPrompt,
      mcpServers: { [SERVER]: server },
      // Разрешаем ровно свои инструменты; встроенные убираем из контекста
      // вовсе, чтобы модель не пыталась чинить наш контейнер вместо модели.
      allowedTools: [`mcp__${SERVER}__*`],
      disallowedTools: BUILT_INS,
      // Спрашивать разрешение не у кого: сервер работает без человека за
      // терминалом. Поэтому любой вызов вне нашего сервера просто отклоняем.
      canUseTool: async (name: string) =>
        name.startsWith(`mcp__${SERVER}__`)
          ? { behavior: 'allow' as const, updatedInput: {} }
          : { behavior: 'deny' as const, message: 'Вне движков инструментов нет.' },
      maxTurns: config.cliMaxTurns,
      // Настройки с диска не читаем: в контейнере лежит наш собственный
      // CLAUDE.md, и он написан для агента-программиста, а не для моделлера.
      settingSources: [],
      includePartialMessages: true,
      cwd: '/tmp',
      ...(resume ? { resume } : {}),
    },
  })

  // Поток SDK и очередь инструментов сливаются в один: первый читаем здесь,
  // вторая наполняется из обработчиков. Читателю снаружи видна одна лента.
  void (async () => {
    try {
      for await (const message of run) {
        if (message.type === 'assistant') {
          const used = message.message?.usage as
            | {
                input_tokens?: number
                output_tokens?: number
                cache_read_input_tokens?: number
                cache_creation_input_tokens?: number
              }
            | undefined
          if (used) {
            const cached = used.cache_read_input_tokens ?? 0
            spent.cached += cached
            spent.prompt +=
              (used.input_tokens ?? 0) + cached + (used.cache_creation_input_tokens ?? 0)
            spent.completion += used.output_tokens ?? 0
          }

          // Чекпойнт по появлению геометрии: обрываем на границе хода модели,
          // а не посреди набора инструментов — иначе часть вызовов останется
          // без ответа, и продолжение начнётся с путаницы.
          if (checkpoint && !stoppedByBudget) {
            stoppedByBudget = true
            await run.interrupt().catch(() => {})
            await takeSnapshot('rhino', undefined, input.sessionId).catch(() => null)
            // Вопрос обязателен. Без него ход просто обрывался: ни карточки,
            // ни текста — модель молча замолкала, и понять это было нельзя.
            queue.push({
              kind: 'ask',
              question:
                'Проход завершён — модель загружена во вьюпорт, посмотрите. ' +
                'Продолжать итерации или остановиться?',
              options: CHOICES,
            })
            queue.push({ kind: 'usage', usage: { ...spent } })
            break
          }

          const total = spent.prompt + spent.completion
          if (config.tokenBudget > 0 && total > config.tokenBudget && !stoppedByBudget) {
            stoppedByBudget = true
            // Прерываем ДО вопроса: иначе модель успеет сделать ещё круг,
            // пока человек читает, и спросим мы уже задним числом.
            await run.interrupt().catch(() => {})
            // Варианты обязательны: карточку рисует именно их наличие, а без
            // неё вопрос уходит мелкой строчкой под полем ввода — там его и
            // не заметили.
            queue.push({ kind: 'ask', question: budgetQuestion(total, lastTool), options: CHOICES })
            queue.push({ kind: 'usage', usage: { ...spent } })
            break
          }
          continue
        }

        if (message.type === 'system' && message.subtype === 'init') {
          sdkSessions.set(input.sessionId, message.session_id)
          // Какую модель SDK взял на самом деле. Просили одну, а имя могло не
          // совпасть с его каталогом — тогда он молча возьмёт умолчание, и
          // узнать об этом иначе будет неоткуда: в ответе модель себя не
          // называет, а угадывать по слогу — не проверка.
          console.log(
            `[SDK ${nowIso()}] просили ${input.model}, работает ${message.model}` +
              (resume ? ', продолжена сессия' : ''),
          )
          continue
        }

        // Текст берём только из потоковых кусков. Готовое сообщение `assistant`
        // повторяет тот же текст целиком — считать оба значит напечатать ответ
        // дважды.
        if (message.type === 'stream_event') {
          const event = message.event as {
            type?: string
            delta?: { type?: string; text?: string }
          }
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const text = event.delta.text ?? ''
            if (text) queue.push({ kind: 'text', text })
          }
          continue
        }

        if (message.type === 'result') {
          // Чем ответил API, а не что мы просили. Стартовое сообщение SDK
          // повторяет принятую настройку и подтверждением не является: имя
          // могло не совпасть с его каталогом, и подмену там не видно.
          // modelUsage собирается из ответов API — вот это факт.
          const actual = Object.keys(
            ('modelUsage' in message ? message.modelUsage : null) ?? {},
          )
          if (actual.length) {
            console.log(`[SDK ${nowIso()}] ответил ${actual.join(', ')}`)
          }
          // Расход лежит вложенным, в том же виде, что у Anthropic API.
          const used = ('usage' in message ? message.usage : null) as {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          } | null
          const cacheRead = used?.cache_read_input_tokens ?? 0
          const cacheWrite = used?.cache_creation_input_tokens ?? 0
          queue.push({
            kind: 'usage',
            usage: {
              // Ввод считаем целиком, вместе с кэшем: иначе доля из кэша
              // получилась бы больше ста процентов.
              prompt: (used?.input_tokens ?? 0) + cacheRead + cacheWrite,
              completion: used?.output_tokens ?? 0,
              cached: cacheRead,
              cost: message.total_cost_usd,
            },
          })
        }
      }
      queue.close()
    } catch (error) {
      queue.close(error)
    }
  })()

  yield* queue.drain()
}

/**
 * Вопрос про исчерпанный бюджет — человеческими словами и с числами.
 *
 * Почему вопрос, а не молчаливый обрыв. Раньше ход упирался в потолок кругов и
 * заканчивался чужой английской строкой в хвосте длинного ответа — заметить её
 * было почти нельзя, и выглядело это так, будто модель бросила работу сама.
 * На деле она чинила найденный ею же брак. Решать, доплачивать ли за починку,
 * должен человек, и для этого ему нужны две вещи: сколько уже потрачено и на
 * чём остановились.
 */
function budgetQuestion(total: number, lastTool: string): string {
  const millions = (total / 1_000_000).toFixed(2)
  const limit = (config.tokenBudget / 1_000_000).toFixed(2)

  return (
    `Потрачено ${millions} млн токенов — предел на один ход ${limit} млн. ` +
    (lastTool ? `Работа не закончена, последним шагом был ${lastTool}. ` : 'Работа не закончена. ') +
    'Продолжать? Ответьте «продолжай» — я вернусь ровно туда, где остановился, ' +
    'с новым бюджетом. Ответьте «хватит» — оставлю как есть и расскажу, что успел.'
  )
}

/** Варианты ответа на чекпойнте — три, как и просили. */
const CHOICES = ['Продолжить итерации', 'Оставить как есть', 'Скажу своими словами']

/** Инструменты, после которых в сцене могла появиться геометрия. */
const BUILDING = new Set(['mc_run_python', 'mc_run_command', 'rh_run_python', 'rh_create_objects'])

/**
 * Сколько объектов в документе. Минус один — спросить не удалось.
 *
 * Отдельный дешёвый вызов вместо снимка: снимок Rhino — это мегабайты, и
 * дёргать его после каждого скрипта значило бы платить за проверку дороже,
 * чем за работу. `get_context` заведён у McNeel ровно для такого.
 */
async function objectCount(): Promise<number> {
  try {
    const raw = (await agents.invoke({
      engine: 'rhino',
      command: 'mc:get_context',
      params: {},
    })) as { output?: string }
    const box = JSON.parse(String(raw?.output ?? '{}')) as { document?: { objectCount?: number } }
    return box.document?.objectCount ?? 0
  } catch {
    // Не спросилось — не повод обрывать работу. Останется бюджетный крючок.
    return -1
  }
}

/** Что показать человеку на чекпойнте: сделанное и честно слабое. */
function iterationQuestion(args: Record<string, unknown>): string {
  const done = String(args.done ?? '').trim()
  const weak = String(args.weak ?? '').trim()

  const lines = ['Проход завершён. Модель загружена во вьюпорт — посмотрите.', '', done]
  if (weak) lines.push('', `Сам считаю слабым: ${weak}`)
  lines.push('', 'Продолжать итерации, оставить как есть или скажете своими словами?')

  return lines.join('\n')
}

/** Читающие инструменты узнаём по имени — так же, как их называет реестр. */
function isReadOnly(name: string): boolean {
  return /_(get|list|info|inspect|look|model_info|selection|entities)/.test(name)
}
