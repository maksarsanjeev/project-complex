import type {
  ChatEvent,
  EngineId,
  ParametricMode,
  ChatMessage,
  ModelProvider,
  SelectionRef,
  ToolCall,
} from '@complex/protocol'
import { config } from './config.ts'
import { newId, nowIso } from './db/db.ts'
import * as agents from './agents.ts'
import { appendMessage, listMessages } from './db/repo.ts'
import * as repo from './db/repo.ts'
import {
  ASK_TOOL_NAME,
  availableTools,
  engineSummary,
  runTool,
  toWireTools,
} from './tools/registry.ts'
import { cliConfigured, runClaudeCode } from './llm/claudeCode.ts'
import type { LlmPiece, Usage } from './llm/piece.ts'

export type { Usage } from './llm/piece.ts'

/**
 * Живой ответ модели через OpenRouter — один ключ на множество моделей,
 * включая Claude. Поток приходит по SSE и пересылается наружу событиями
 * `token`, так что веб-морда собирает ответ ровно так же, как раньше собирала
 * его от мока: сторона клиента не меняется вовсе.
 *
 * Без ключа сервис не падает, а честно отвечает, что модель не подключена.
 *
 * ВЫХОД В ИНТЕРНЕТ. OpenRouter закрыт Cloudflare для российских адресов —
 * возвращает 403 даже на запрос без ключа. Поэтому на сервере поднят
 * локальный прокси, а запросы уходят через него.
 *
 * Тонкость, которая стоила часа: встроенный в Node fetch НЕ смотрит на
 * HTTPS_PROXY сам по себе. Замерено на живом сервере — с одной этой
 * переменной по-прежнему 403, и только вместе с NODE_USE_ENV_PROXY=1
 * получается 200. Обе переменные заданы в /opt/complex/.env.
 */

/* ────────────────────────── формат обмена с моделью ────────────────────────── */

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Кусок содержимого: текст или картинка. Картинки бывают только у роли user.
 *
 * `cache_control` помечает границу кэша подсказки. Всё, что ДО пометки
 * включительно, провайдер запоминает и в следующих запросах берёт из кэша —
 * примерно вдесятеро дешевле обычного ввода.
 */
type WireContent =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image_url'; image_url: { url: string } }

type WireMessage =
  | { role: 'system'; content: string | WireContent[] }
  | { role: 'user'; content: string | WireContent[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** Что вернул один круг общения с моделью. */
interface Round {
  text: string
  calls: WireToolCall[]
}

/* ────────────────────────── история ────────────────────────── */

/** Сколько последних сообщений и знаков подаём модели. */
const HISTORY_LIMIT = 30
const HISTORY_CHARS = 12_000

/**
 * Собирает историю переписки для модели.
 *
 * ВАЖНО: сообщение пользователя уже лежит в базе — его сохраняет sendMessage
 * ДО вызова streamAnswer. Поэтому текст запроса сюда отдельно добавлять не
 * нужно, иначе модель увидит вопрос дважды и начнёт отвечать на него как на
 * повтор.
 *
 * Прошлые вызовы инструментов сворачиваются в короткую пометку. Восстанавливать
 * из базы настоящие tool_call_id незачем: модели достаточно знать, что было
 * сделано и чем кончилось, а полная точность нужна только внутри текущего хода.
 */
function buildHistory(sessionId: string): WireMessage[] {
  const all = listMessages(sessionId)
  const recent = all.slice(-HISTORY_LIMIT)

  const messages: WireMessage[] = []
  let budget = HISTORY_CHARS

  // Идём с конца: если бюджета не хватит, обрезать надо старое, а не свежее.
  for (let i = recent.length - 1; i >= 0; i--) {
    const message = recent[i]
    if (!message) continue

    const notes = (message.toolCalls ?? [])
      .map((call) => `[${call.name} → ${call.status === 'ok' ? 'выполнено' : 'ошибка'}]`)
      .join(' ')
    const content = [message.content, notes].filter(Boolean).join('\n')
    if (!content.trim()) continue

    budget -= content.length
    if (budget < 0) break

    messages.unshift({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    })
  }

  return messages
}

/* ────────────────────────── ход разговора ────────────────────────── */

export async function* streamAnswer(input: {
  sessionId: string
  text: string
  provider?: ModelProvider
  selection?: SelectionRef[]
  /**
   * Движок, выбранный в панели. Главнее записанного в сессии: сессия помнит,
   * с чем её создали, а человек переключает движок по ходу дела — и ожидает,
   * что переключатель работает.
   */
  engine?: EngineId | null
  /** Нужна ли параметрика: решено человеком или оставлено на вопрос модели. */
  parametric?: ParametricMode
}): AsyncGenerator<ChatEvent> {
  const bound = input.engine ?? repo.sessionEngine(input.sessionId)
  const parametric: ParametricMode = input.parametric ?? 'ask'
  const messageId = newId('m')
  const model = input.provider?.model || config.defaultModel

  const message: ChatMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    createdAt: nowIso(),
    model,
    streaming: true,
    toolCalls: [],
  }
  yield { type: 'message-start', message }

  let text = ''
  const toolCalls: ToolCall[] = []
  // Расход копится по всем кругам хода: один вопрос пользователя может стоить
  // нескольких обращений к модели, и считать надо ход целиком.
  const spent: Usage = { prompt: 0, completion: 0, cached: 0, cost: 0 }

  // Модель, которую нельзя вызвать, лучше назвать вслух, чем отправить запрос
  // и вернуть невнятную ошибку провайдера. Так выходило с выбором CLI: его имя
  // модели не существует в OpenRouter, и вместо «CLI ещё не подключён»
  // пользователь получал бы 400 с чужой формулировкой.
  const refusal = explainUnavailable(input.provider)
  if (refusal) {
    for (const piece of refusal.split(/(\s+)/)) {
      await sleep(12)
      text += piece
      yield { type: 'token', messageId, text: piece }
    }
    appendMessage(input.sessionId, { ...message, content: text, streaming: false, toolCalls: [] })
    yield { type: 'message-end', messageId }
    return
  }

  // Мост проверяем ДО модели, а не в процессе. Иначе выходит так, как вышло:
  // человек ждал больше десяти минут, а модель всё это время упиралась в
  // таймауты и в конце сказала, что моста нет. Проверка стоит одного дешёвого
  // запроса и отвечает за секунды.
  // «Работать без движка» — осознанный ответ на эту же карточку. Проверять
  // мост снова значит показать её заново, и человек попадает в круг, из
  // которого нет выхода: любая кнопка возвращает тот же вопрос.
  const skipCheck = /без движка/i.test(input.text)
  const trouble = skipCheck ? null : await bridgeTrouble(bound)
  if (trouble) {
    text = trouble.text
    yield { type: 'token', messageId, text }
    yield { type: 'ask', messageId, question: trouble.text, options: trouble.options }
    appendMessage(input.sessionId, { ...message, content: text, streaming: false, toolCalls: [] })
    yield { type: 'message-end', messageId }
    return
  }

  // Строки, которые меняются от хода к ходу: кем вызвали, что запущено и что
  // выделено.
  const contextText = [describeModel(input.provider, model), describeParametric(parametric, bound), engineSummary(), describeSelection(input.selection)]
    .filter(Boolean)
    .join('\n\n')

  try {
    const pieces =
      input.provider?.transport === 'cli'
        ? runClaudeCode({
            sessionId: input.sessionId,
            text: input.text,
            model: input.provider.model,
            // У Agent SDK нет отдельных блоков с метками кэша: он кэширует
            // разговор сам, продолжая свою сессию. Поэтому подсказка склеена
            // в одну строку — делить её тут больше не за чем.
            systemPrompt: [SYSTEM_PROMPT, contextText].filter(Boolean).join('\n\n'),
            selection: input.selection,
            // Оба поля обязаны быть здесь. Их отсутствие типы не ловят —
            // они необязательные, — и путь Agent SDK молча работал со всеми
            // движками сразу и без Grasshopper, пока OpenRouter вёл себя верно.
            engine: bound,
            parametric,
          })
        : runOpenRouter({ sessionId: input.sessionId, model, contextText, engine: bound, parametric })

    for await (const piece of pieces) {
      if (piece.kind === 'text') {
        text += piece.text
        yield { type: 'token', messageId, text: piece.text }
      } else if (piece.kind === 'usage') {
        spent.prompt += piece.usage.prompt
        spent.completion += piece.usage.completion
        spent.cached += piece.usage.cached
        spent.cost = (spent.cost ?? 0) + (piece.usage.cost ?? 0)
      } else if (piece.kind === 'tool-start') {
        yield {
          type: 'tool-call',
          messageId,
          toolCall: {
            id: piece.id,
            name: piece.name,
            // Настоящий движок известен только после выполнения — до него
            // подставляем SketchUp, чтобы блок вызова было чем нарисовать.
            engine: 'sketchup',
            status: 'running',
            code: JSON.stringify(piece.args),
          },
        }
      } else if (piece.kind === 'tool-done') {
        const finished: ToolCall = {
          id: piece.id,
          name: piece.name,
          engine: piece.outcome.engine,
          status: piece.outcome.ok ? 'ok' : 'error',
          code: piece.outcome.code,
          result: piece.outcome.content,
          durationMs: piece.outcome.durationMs,
        }
        toolCalls.push(finished)
        yield { type: 'tool-update', messageId, toolCall: finished }
      } else {
        yield { type: 'ask', messageId, question: piece.question, options: piece.options }
        // Вопрос попадает и в текст ответа: иначе после перезагрузки страницы
        // в переписке осталась бы пустота вместо заданного вопроса.
        text += (text ? '\n\n' : '') + piece.question
      }
    }
  } catch (error) {
    const note = error instanceof Error ? error.message : 'сбой обращения к модели'
    text += `\n\n[${note}]`
    yield { type: 'token', messageId, text: `\n\n[${note}]` }
  }

  // Сообщение сохраняем целиком и один раз: писать каждый токен в базу
  // означало бы сотни записей на один ответ. Вызовы инструментов сохраняем
  // вместе с ним — иначе после перезагрузки страницы от работы движка не
  // осталось бы и следа.
  appendMessage(input.sessionId, { ...message, content: text, streaming: false, toolCalls })

  // Доля из кэша — единственный способ увидеть, работает ли кэширование:
  // без него cached всегда 0, и это видно в логе сразу, а не по счёту в конце месяца.
  const share = spent.prompt ? Math.round((spent.cached / spent.prompt) * 100) : 0
  console.log(
    `[расход ${nowIso()}] ввод ${spent.prompt} (из кэша ${spent.cached}, ${share}%), ` +
      `ответ ${spent.completion}${spent.cost ? `, $${spent.cost.toFixed(5)}` : ''}`,
  )

  yield { type: 'usage', messageId, usage: spent }
  yield { type: 'message-end', messageId }
}

/**
 * Цикл инструментов на стороне OpenRouter: спросили — выполнили — спросили
 * снова. У Agent SDK этот цикл свой, поэтому здесь он живёт отдельно, а не
 * посреди общего хода.
 */
async function* runOpenRouter(input: {
  sessionId: string
  model: string
  contextText: string
  engine: EngineId | null
  parametric: ParametricMode
}): AsyncGenerator<LlmPiece> {
  const tools = availableTools(input.engine, input.parametric)
  const conversation: WireMessage[] = [
    {
      role: 'system',
      /*
        Системное сообщение разбито НАДВОЕ ради кэша, и порядок здесь не косметика.

        Кэш работает по совпадающему НАЧАЛУ запроса: провайдер запоминает всё до
        пометки и в следующий раз не считает заново — примерно вдесятеро дешевле.
        Описания инструментов идут в запросе перед системным сообщением, поэтому
        пометка на первом блоке кэширует и их — а это самая тяжёлая и самая
        неизменная часть, около 3 600 токенов на каждом ходу.

        Во второй блок уходит всё, что меняется от сообщения к сообщению:
        состояние движков и текущее выделение. Будь они в первом, кэш промахивался
        бы каждый раз, когда человек выделил другой объект, — то есть всегда.
      */
      content: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: input.contextText },
      ],
    },
    ...buildHistory(input.sessionId),
  ]

  let asked = false
  // Расход хода — для того же предела, что и на пути Agent SDK. Считаем сами:
  // отсюда цифры уходят наружу кусками, а сравнивать надо накопленное.
  let spent = 0

  // Круг = один запрос к модели. Пока она просит инструменты — продолжаем.
  for (let round = 0; round < config.maxToolRounds; round++) {
    const result: Round = { text: '', calls: [] }

    for await (const piece of streamRound(conversation, input.model, tools)) {
      if (piece.kind === 'text') {
        result.text += piece.text
        yield { kind: 'text', text: piece.text }
      } else if (piece.kind === 'usage') {
        spent += piece.usage.prompt + piece.usage.completion
        yield { kind: 'usage', usage: piece.usage }
      } else {
        result.calls = piece.calls
      }
    }

    if (!result.calls.length) break

    conversation.push({
      role: 'assistant',
      content: result.text || null,
      tool_calls: result.calls,
    })

    // Вопрос пользователю обрывает ход: ответом станет его следующее
    // сообщение. Обрабатываем ДО остальных вызовов — если модель заодно
    // попросила что-то построить, строить вслепую как раз и не надо.
    const ask = result.calls.find((c) => c.function.name === ASK_TOOL_NAME)
    if (ask) {
      const args = parseArguments(ask.function.arguments)
      const question = String(args.question ?? '').trim()
      const options = Array.isArray(args.options) ? args.options.map(String) : undefined
      if (question) {
        yield { kind: 'ask', question, options }
        asked = true
        break
      }
    }

    for (const call of result.calls) {
      const args = parseArguments(call.function.arguments)

      yield { kind: 'tool-start', id: call.id, name: call.function.name, args }
      const outcome = await runTool(call.function.name, args)
      yield { kind: 'tool-done', id: call.id, name: call.function.name, outcome }

      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.content,
      })

      // Снимок вьюпорта модель должна УВИДЕТЬ, а не прочитать описанием.
      // Ответ инструмента в формате OpenAI несёт только текст, поэтому
      // картинка идёт следом отдельным сообщением. Без этого «посмотри на
      // модель» осталось бы фигурой речи. У Agent SDK так изворачиваться не
      // приходится: там картинка — законный блок ответа инструмента.
      if (outcome.image) {
        conversation.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Вот снимок вьюпорта по твоему запросу. Посмотри и оцени результат.' },
            {
              type: 'image_url',
              image_url: { url: `data:${outcome.image.mime};base64,${outcome.image.base64}` },
            },
          ],
        })
      }
    }

    if (asked) break

    // Предел расхода — не обрыв, а вопрос: продолжать ли. Проверяем после
    // круга целиком, а не после каждого вызова: обрывать посреди набора
    // инструментов одного круга нельзя, модель ждёт ответа на каждый.
    if (config.tokenBudget > 0 && spent > config.tokenBudget) {
      yield {
        // Без вариантов вопрос показывается строчкой под вводом, а не
        // карточкой, и его пропускают.
        kind: 'ask',
        options: ['Продолжай', 'Хватит, остановись'],
        question:
          `Потрачено ${(spent / 1_000_000).toFixed(2)} млн токенов — предел на один ход ` +
          `${(config.tokenBudget / 1_000_000).toFixed(2)} млн. Работа не закончена. ` +
          'Продолжать? Ответьте «продолжай» — вернусь туда, где остановился, с новым бюджетом.',
      }
      break
    }

    // Круги кончились, а модель всё просит инструменты — говорим прямо.
    if (round === config.maxToolRounds - 1) {
      yield {
        kind: 'text',
        text: `\n\n[остановился: за ${config.maxToolRounds} кругов работа не сошлась]`,
      }
    }
  }
}

/**
 * Живой ли мост движка, к которому привязана сессия.
 *
 * Проверяется до модели и одним дешёвым читающим вызовом. Смысл не в том,
 * чтобы поймать редкий сбой, а в том, чтобы не платить за него временем
 * человека: мёртвый сокет агента выглядит как живой, инструменты публикуются,
 * и модель узнаёт правду только после нескольких таймаутов подряд.
 *
 * Возвращает null, когда всё в порядке.
 */
async function bridgeTrouble(
  engine: EngineId | null,
): Promise<{ text: string; options: string[] } | null> {
  if (!engine || engine === 'blender') return null

  const label = engine === 'rhino' ? 'Rhino' : 'SketchUp'
  const how =
    engine === 'rhino'
      ? 'В Rhino наберите в командной строке MCPStart — плагин поднимет мост на 10501. ' +
        'Если команда не найдена, плагин RhinoMCP не установлен или Rhino не перезапускался после установки.'
      : 'В SketchUp откройте «Расширения → MCP Server» и запустите мост. ' +
        'Если пункта меню нет, плагин не установлен или SketchUp не перезапускался после установки.'

  if (!agents.isOnline(engine)) {
    return {
      text:
        `${label} не на связи: агент не видит запущенного приложения. ` +
        `Проверьте, что ${label} открыт и агент запущен на вашей машине. ${how}`,
      options: [`${label} запущен — проверь ещё раз`, 'Работать без движка'],
    }
  }

  try {
    await agents.invoke({
      engine,
      command: engine === 'rhino' ? 'mc:get_context' : 'GET /model/info',
      params: {},
    })
    return null
  } catch (error) {
    // Приложение числится запущенным, а мост молчит — это и есть тот случай,
    // ради которого проверка заведена.
    const why = error instanceof Error ? error.message : 'мост не ответил'
    return {
      text:
        `${label} числится запущенным, но мост не отвечает: ${why}. ` +
        `Строить сейчас нельзя — вызовы уйдут в пустоту. ${how}`,
      options: [`Мост поднят — проверь ещё раз`, 'Работать без движка'],
    }
  }
}

/**
 * Что человек решил про параметрику — и что из этого следует для модели.
 *
 * Три состояния, потому что при двух отметка человека и вопрос модели
 * противоречат друг другу: отметил «не нужна», а модель всё равно спрашивает.
 * «Спросить» — это не отсутствие решения, а решение спросить.
 */
function describeParametric(mode: ParametricMode, engine: EngineId | null): string {
  if (engine !== 'rhino') return ''

  if (mode === 'yes') {
    return (
      'Человек включил параметрику: работа должна получиться управляемой из Grasshopper. ' +
      'Инструменты холста (gh_*) тебе выданы. Спрашивать про это не надо — решено. ' +
      'Помни: готовое тело параметрическим не станет, историю построения оно не хранит. ' +
      'Поэтому решай устройство графа ДО постройки, а не приделывай его после. ' +
      'СОБРАЛ ГРАФ — СРАЗУ ЗАПЕКИ РЕЗУЛЬТАТ В ДОКУМЕНТ. Команды «запечь» у плагина нет, ' +
      'делай это скриптом через mc_run_python: пройди объекты холста и добавь их геометрию ' +
      'в документ, разложив по слоям материалов. Без этого работы как бы и нет: Grasshopper ' +
      'показывает превью, а не объекты, и человек увидит пустую сцену во вьюпорте, пустое ' +
      'дерево и пустой снимок — при полностью исправном графе. ' +
      'Запекай после каждого готового узла, а не в самом конце: так виден прогресс, ' +
      'и не пропадёт всё сразу, если ход оборвётся.'
    )
  }

  if (mode === 'no') {
    return (
      'Человек выключил параметрику: строим обычной геометрией, Grasshopper не привлекаем. ' +
      'Инструментов холста у тебя нет, и предлагать их не надо — это уже решено.'
    )
  }

  return (
    'Про параметрику человек не решил. Если задача выиграет от управляемости размерами — ' +
    'спроси ОДИН раз, прежде чем строить, через инструмент вопроса: нужна ли параметрика ' +
    'на Grasshopper. Объясни коротко, чем это обернётся: граф строит геометрию заново, ' +
    'и приделать его к уже готовым телам нельзя — историю построения они не хранят. ' +
    'Задача простая и параметры менять незачем — не спрашивай вовсе, просто строй.'
  )
}

/**
 * Кем модель вызвали — её собственными словами.
 *
 * Зачем это вообще нужно. Модель не знает, под каким именем её позвали: в
 * запросе имя есть, но самой модели оно не сообщается. На вопрос «ты Sonnet
 * или Opus?» она честно отвечает «не знаю» — и это правильный ответ с её
 * стороны, но бесполезный с нашей: у нас в шапке чата стоит переключатель, и
 * человек имеет право проверить, что переключатель работает.
 *
 * Знает это gateway — он и подсказывает. Даём и человеческое название, и
 * настоящее имя: первое совпадает с подписью в чате, второе — с тем, что уходит
 * провайдеру и пишется в лог.
 */
function describeModel(provider: ModelProvider | undefined, model: string): string {
  const label = provider?.label ?? model
  const where = provider?.transport === 'cli' ? 'через Claude Agent SDK' : 'через OpenRouter'

  return (
    `Тебя вызвали как «${label}» (${model}) ${where}. ` +
    'Если спросят, какая ты модель, — назови это, не отговаривайся незнанием. ' +
    'Про всё остальное про себя догадками не отвечай.'
  )
}

/**
 * Что выделено во вьюпорте — словами, которые модель может использовать.
 *
 * Ключевая подробность: идентификатор узла вида `ent:43725` несёт в себе
 * настоящий entityID SketchUp. Это ровно то число, которое принимают
 * su_push_pull, su_move, su_boolean и остальные инструменты правки, поэтому
 * его и называем прямо — иначе модель пошла бы искать объект списком.
 */
function describeSelection(selection?: SelectionRef[]): string {
  // Молчать, когда выделения нет, оказалось плохой мыслью: на вопрос «какой
  // объект я выделил» модель молча шла смотреть выделение в самом SketchUp и
  // отвечала про него. Два разных выделения подменялись одно другим. Поэтому
  // говорим и про пустоту тоже.
  if (!selection?.length) {
    return 'В веб-морде сейчас ничего не выделено. Если человек ссылается на «выделенное», ' +
      'уточни, что он имеет в виду, либо посмотри выделение в самом SketchUp через su_get_selection — ' +
      'но тогда так и скажи, что смотришь выделение в приложении, а не в веб-морде.'
  }

  const entityIds = selection
    .map((item) => (item.id.startsWith('ent:') ? item.id.slice(4) : null))
    .filter((id): id is string => id !== null)

  const list = selection
    .map((item) => {
      const layer = item.layer ? `, слой «${item.layer}»` : ''
      const entity = item.id.startsWith('ent:') ? `, entity_id ${item.id.slice(4)}` : ''
      const kind = item.kind === 'layer' ? ' (это слой целиком)' : ''
      return `«${item.name}»${kind}${layer}${entity}`
    })
    .join('; ')

  const many = selection.length > 1

  return (
    `Пользователь выделил в веб-морде ${many ? `${selection.length} объекта(ов)` : 'объект'}: ${list}. ` +
    (entityIds.length
      ? `Их entity_id в SketchUp: ${entityIds.join(', ')} — используй именно эти числа в инструментах правки. `
      : '') +
    'Когда он говорит «этот объект», «выделенное», «эти» — речь про них. ' +
    (many ? 'Правки применяй ко всем перечисленным, если он не сказал иначе. ' : '') +
    'Если выделен слой, работать надо со всеми объектами внутри него — их состав смотри в дереве модели.'
  )
}

/**
 * Почему выбранной моделью нельзя воспользоваться — или null, если можно.
 * Пустая строка и null тут не одно и то же: null означает «всё в порядке».
 */
function explainUnavailable(provider?: ModelProvider): string | null {
  if (provider?.transport === 'cli') {
    return cliConfigured()
      ? null
      : `${provider.label} не настроен: на сервере нет ни CLAUDE_CODE_OAUTH_TOKEN, ` +
        'ни ANTHROPIC_API_KEY. Сообщение сохранено, выбери другую модель.'
  }

  if (provider && !provider.configured) {
    return `${provider.label} не настроен на сервере. Сообщение сохранено, выбери другую модель.`
  }

  if (!config.openRouterKey) {
    return (
      'Модель не подключена: на сервере не задан OPENROUTER_API_KEY. ' +
      'Хранение при этом работает — сообщение сохранено в базе.'
    )
  }

  return null
}

/** Аргументы приходят строкой и вполне могут оказаться битыми. */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/* ────────────────────────── один запрос к модели ────────────────────────── */

type RoundPiece =
  | { kind: 'text'; text: string }
  | { kind: 'calls'; calls: WireToolCall[] }
  /** Сколько стоил круг. Приходит последним кадром потока. */
  | { kind: 'usage'; usage: Usage }

async function* streamRound(
  messages: WireMessage[],
  model: string,
  tools: ReturnType<typeof availableTools>,
): AsyncGenerator<RoundPiece> {
  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages,
    // Без этого расход в потоке не приходит вовсе, и померить кэш нечем.
    stream_options: { include_usage: true },
    usage: { include: true },
  }
  // Пустой список инструментов отправлять нельзя: часть провайдеров считает
  // это ошибкой. Нет движков — нет и поля.
  if (tools.length) body.tools = toWireTools(tools)

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openRouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'project complex',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter ответил ${response.status}: ${await response.text()}`)
  }

  yield* readServerSentEvents(response.body)
}

/**
 * Разбор потока SSE. Куски приходят по границам сети, а не по границам строк,
 * поэтому хвост неполной строки переносим в следующую итерацию.
 *
 * Вызовы инструментов приезжают по частям: имя функции обычно целиком в первой
 * дельте, а аргументы склеиваются из кусков. Связка между кусками — поле
 * `index`, а НЕ `id`: идентификатор приходит только с первым куском.
 */
async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<RoundPiece> {
  const decoder = new TextDecoder()
  let buffer = ''
  const calls = new Map<number, WireToolCall>()

  const finish = (): RoundPiece => ({
    kind: 'calls',
    calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
  })

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') {
        yield finish()
        return
      }

      try {
        const parsed = JSON.parse(payload) as {
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            cost?: number
            prompt_tokens_details?: { cached_tokens?: number }
          }
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
          }>
        }

        if (parsed.usage) {
          yield {
            kind: 'usage',
            usage: {
              prompt: parsed.usage.prompt_tokens ?? 0,
              completion: parsed.usage.completion_tokens ?? 0,
              cached: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
              cost: parsed.usage.cost,
            },
          }
        }

        const delta = parsed.choices?.[0]?.delta
        if (!delta) continue

        if (delta.content) yield { kind: 'text', text: delta.content }

        for (const part of delta.tool_calls ?? []) {
          const existing = calls.get(part.index) ?? {
            id: part.id ?? `call_${part.index}`,
            type: 'function' as const,
            function: { name: '', arguments: '' },
          }
          if (part.id) existing.id = part.id
          if (part.function?.name) existing.function.name = part.function.name
          if (part.function?.arguments) existing.function.arguments += part.function.arguments
          calls.set(part.index, existing)
        }
      } catch {
        // Служебные строки без полезной нагрузки просто пропускаем.
      }
    }
  }

  // Поток кончился без [DONE] — такое бывает при обрыве соединения.
  yield finish()
}

const SYSTEM_PROMPT = [
  'Ты помогаешь моделировать архитектуру, интерьеры и предметы.',
  'ПЕРВЫЙ ПРОХОД ДОЛЖЕН БЫТЬ ЦЕЛЬНЫМ И СДАВАЕМЫМ. Собрал вещь — вызывай iteration_done',
  'и жди человека. Полировать по своей инициативе нельзя: планка «готово» у тебя внутренняя',
  'и дна не имеет, а решает человек. За один заход без остановки набирается два десятка',
  'кругов доводки, о которой никто не просил.',
  'Примитив вместо детали считается браком: коробка вместо курка, труба вместо патрона.',
  'ЧУЖУЮ РАБОТУ СНАЧАЛА СОХРАНИ. В сцене что-то лежит и это не твоё — сохрани документ',
  'через mc_save_doc в файл с датой и понятным именем, скажи человеку путь, и только',
  'потом очищай сцену. Стереть чужую модель без сохранения нельзя ни при каких условиях.',
  'Закладывай технологические зазоры и сопряжения — вещь должна быть похожа на настоящую,',
  'а не на узнаваемый силуэт.',
  'Отвечай по-русски, кратко и по делу.',
  'Единица измерения во всём пайплайне — миллиметр: все размеры в инструментах задавай в мм.',
  'Прежде чем строить, разложи объект на отдельные части и назови габарит.',
  'СНАЧАЛА СЧИТАЙ, ПОТОМ СТРОЙ. Выпиши координаты и углы каждой детали числами до того,',
  'как создашь первую: посчитанное вслух легко проверить, а угаданное на глаз приходится',
  'переделывать по три раза. Строй пакетно одним вызовом, где инструмент это позволяет.',
  'Слои называй по материалу — кирпич, стекло, бетон, дерево, — а не по назначению.',
  'РАБОТАЙ ТОЛЬКО В ДВИЖКЕ ЭТОГО ПРОЕКТА. Инструменты других приложений тебе не выданы —',
  'если нужного инструмента нет, значит проект привязан к другому движку, и об этом надо',
  'сказать человеку, а не искать обходной путь в соседнем приложении.',
  'Прежде чем править существующую геометрию, посмотри на неё соответствующим инструментом:',
  'идентификаторы объектов нельзя угадать, их получают из списка.',
  'Никогда не сообщай, что построил что-то, если вызов инструмента не прошёл.',
  'У тебя есть глаза: su_look показывает снимок вьюпорта, и ты его действительно видишь.',
  'После построения сложного объекта посмотри на него — числа сходятся и у вывернутой геометрии.',
  '',
  'ПРОВЕРЯЙ РЕЗУЛЬТАТ, А НЕ ФАКТ ВЫЗОВА. Успешный вызов означает только то, что команда',
  'дошла до движка, — но не то, что получилось задуманное. После каждой правки перечитай',
  'модель и убедись: объект появился, исчез, сдвинулся, стал нужного размера. Особенно это',
  'касается удаления, отмены и всего, что делается через выполнение кода. Если проверка',
  'расходится с ожиданием — скажи об этом прямо, а не докладывай об успехе.',
  '',
  'Если объект нужно вернуть, не выдавай пересоздание за восстановление: новый объект встанет',
  'туда, куда ты его поставишь, а не туда, где был исходный. Скажи, что создал заново, и укажи',
  'положение — либо сперва запомни координаты, а потом восстанови их.',
].join(' ')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
