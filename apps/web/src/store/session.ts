import type { ChatEvent, ChatMessage, GraphDoc, ParamValue, Session } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'
import { useChat } from './chat'
import { useLoadedModel } from '../viewport/loader'
import { useModel } from './model'

interface SessionState {
  sessions: Session[]
  trash: Session[]
  activeId: string | null
  messages: ChatMessage[]
  graph: GraphDoc
  /** Узел графа, выбранный в редакторе, — его настройки правит инспектор. */
  selectedNodeId: string | null
  loading: boolean
  query: string

  init: () => Promise<void>
  select: (id: string) => Promise<void>
  setQuery: (q: string) => void
  reloadSnapshots: () => Promise<void>
  refresh: () => Promise<void>
  loadTrash: () => Promise<void>

  createSession: () => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  restoreSession: (id: string) => Promise<void>
  purgeSession: (id: string) => Promise<void>

  pushMessage: (message: ChatMessage) => void
  applyChatEvent: (event: ChatEvent) => void

  setGraph: (doc: GraphDoc) => void
  selectNode: (id: string | null) => void
  updateNodeParam: (nodeId: string, key: string, value: ParamValue) => void
}

const emptyGraph: GraphDoc = { nodes: [], edges: [] }

/**
 * Какой проект был открыт последним.
 *
 * Держим в localStorage, а не на сервере: это состояние ЭТОГО браузера, а не
 * пользователя. С двух вкладок люди смотрят разные проекты, и синхронизировать
 * их через сервер значило бы мешать друг другу.
 */
const LAST_SESSION_KEY = 'complex.lastSession'

function readLastSession(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY)
  } catch {
    // Приватный режим и запрет хранилища — не повод падать: откроем первый.
    return null
  }
}

function rememberSession(id: string): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, id)
  } catch {
    /* пусто */
  }
}

export const useSession = create<SessionState>()((set, get) => ({
  sessions: [],
  trash: [],
  activeId: null,
  messages: [],
  graph: emptyGraph,
  selectedNodeId: null,
  loading: true,
  query: '',

  async init() {
    const [sessions, trash] = await Promise.all([transport.listSessions(), transport.listTrash()])
    set({ sessions, trash })

    // Открываем ТОТ проект, в котором работали, а не первый в списке.
    //
    // Без этого перезагрузка страницы выбрасывала в чужой проект вместе с его
    // моделью — и выглядело это как «во вьюпорте осталась модель предыдущего
    // проекта», хотя очистка работала правильно: просто открывался не тот
    // проект. Список отсортирован по времени изменения, и первым оказывался
    // тот, где последним отвечала модель.
    const remembered = readLastSession()
    const wanted = sessions.find((x) => x.id === remembered) ?? sessions[0]
    if (wanted) await get().select(wanted.id)
    else set({ loading: false })
  },

  async select(id) {
    set({ loading: true, activeId: id, selectedNodeId: null })
    rememberSession(id)
    // Всё, что принадлежало предыдущему проекту, убираем СРАЗУ, не дожидаясь
    // ответа сервера: иначе в новом проекте висит чужое.
    //
    // Снимок — не единственное такое. Загруженный файлом объект живёт в другом
    // хранилище и переживал переключение, а карточка с вопросом продолжала
    // висеть поверх вьюпорта уже нового проекта: вопрос был задан в прошлом
    // разговоре, отвечать на него здесь бессмысленно.
    useModel.getState().adopt([])
    useLoadedModel.getState().clear()
    useChat.getState().setCheckpoint(null)
    useChat.getState().setPendingOptions([])
    useChat.getState().resetUsage()
    const state = await transport.openSession(id)
    set({
      activeId: state.session.id,
      messages: state.messages,
      graph: state.graph,
      loading: false,
    })
    // У каждой сессии своя модель. Нет своей — вьюпорт остаётся пустым, а не
    // показывает соседнюю.
    useModel.getState().adopt(state.snapshots ?? [])
  },

  /**
   * Перечитать снимки открытой сессии.
   *
   * Нужен на чекпойнте: модель уже положила снимок в базу, и повторно дёргать
   * движок незачем — снимок Rhino это мегабайты и секунды.
   */
  async reloadSnapshots() {
    const id = get().activeId
    if (!id) return
    const state = await transport.openSession(id)
    if (get().activeId !== id) return
    useModel.getState().adopt(state.snapshots ?? [])
  },

  setQuery: (query) => set({ query }),

  /** Поиск делает транспорт: содержимого переписки других сессий на клиенте нет. */
  async refresh() {
    const sessions = await transport.searchSessions(get().query)
    set({ sessions })
  },

  async loadTrash() {
    set({ trash: await transport.listTrash() })
  },

  async createSession() {
    const session = await transport.createSession({
      title: 'Без названия',
      project: 'Черновики',
      engine: 'rhino',
    })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    await get().select(session.id)
  },

  async renameSession(id, title) {
    const updated = await transport.renameSession(id, title)
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? updated : x)) }))
  },

  async deleteSession(id) {
    await transport.deleteSession(id)
    await Promise.all([get().refresh(), get().loadTrash()])
    // Если удалили открытую сессию — переключаемся на первую оставшуюся.
    if (get().activeId === id) {
      const next = get().sessions[0]
      if (next) await get().select(next.id)
      else set({ activeId: null, messages: [], graph: emptyGraph })
    }
  },

  async restoreSession(id) {
    await transport.restoreSession(id)
    await Promise.all([get().refresh(), get().loadTrash()])
  },

  async purgeSession(id) {
    await transport.purgeSession(id)
    await get().loadTrash()
  },

  pushMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),

  /** Разбор потока событий ответа — здесь же дописывается стриминг. */
  applyChatEvent(event) {
    switch (event.type) {
      case 'message-start':
        set((s) => ({ messages: [...s.messages, event.message] }))
        break

      case 'token':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.messageId ? { ...m, content: m.content + event.text } : m,
          ),
        }))
        break

      case 'tool-call':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.messageId
              ? { ...m, toolCalls: [...(m.toolCalls ?? []), event.toolCall] }
              : m,
          ),
        }))
        break

      case 'tool-update':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.messageId
              ? {
                  ...m,
                  toolCalls: (m.toolCalls ?? []).map((tc) =>
                    tc.id === event.toolCall.id ? event.toolCall : tc,
                  ),
                }
              : m,
          ),
        }))
        break

      case 'message-end':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.messageId ? { ...m, streaming: false } : m,
          ),
        }))
        break

      case 'usage':
        useChat.getState().addUsage(event.usage)
        break

      case 'ask':
        // Вопрос с вариантами — это чекпойнт итерации: модель собрала проход и
        // ждёт решения. Показывается карточкой поверх вьюпорта, потому что
        // решается тут не мелочь, а тратить ли ещё миллион токенов.
        //
        // Вопрос без вариантов — обычное уточнение по ходу дела, ему хватает
        // строчки кнопок под полем ввода.
        if (event.options?.length) {
          useChat.getState().setCheckpoint({ question: event.question, options: event.options })
          // Снимок сервер уже положил в сессию — забираем его СО СВОЕЙ стороны,
          // не тревожа движок повторно: там мегабайты.
          void get().reloadSnapshots()
        } else {
          useChat.getState().setPendingOptions(event.options ?? [])
        }
        break

      case 'scene-patch':
        // Дерево сцены придёт от движка; сейчас его строит сам вьюпорт.
        break

      case 'error':
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: `err-${s.messages.length}`,
              role: 'system',
              content: event.message,
              createdAt: new Date().toISOString(),
            },
          ],
        }))
        break
    }
  },

  setGraph(doc) {
    set({ graph: doc })
    const id = get().activeId
    if (id) void transport.saveGraph(id, doc)
  },

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  updateNodeParam(nodeId, key, value) {
    const doc = get().graph
    const next: GraphDoc = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === nodeId ? { ...n, params: { ...(n.params ?? {}), [key]: value } } : n,
      ),
    }
    get().setGraph(next)
  },
}))

/** Активная сессия целиком — нужна топбару и статусбару. */
export function useActiveSession(): Session | null {
  return useSession((s) => s.sessions.find((x) => x.id === s.activeId) ?? null)
}
