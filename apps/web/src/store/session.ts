import type { ChatEvent, ChatMessage, GraphDoc, SceneNode, Session } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'

interface SessionState {
  sessions: Session[]
  activeId: string | null
  messages: ChatMessage[]
  scene: SceneNode[]
  graph: GraphDoc
  loading: boolean
  query: string

  init: () => Promise<void>
  select: (id: string) => Promise<void>
  setQuery: (q: string) => void
  createSession: () => Promise<void>

  pushMessage: (message: ChatMessage) => void
  applyChatEvent: (event: ChatEvent) => void

  toggleNodeVisible: (id: string) => void
  toggleNodeLocked: (id: string) => void
  setGraph: (doc: GraphDoc) => void
}

const emptyGraph: GraphDoc = { nodes: [], edges: [] }

export const useSession = create<SessionState>()((set, get) => ({
  sessions: [],
  activeId: null,
  messages: [],
  scene: [],
  graph: emptyGraph,
  loading: true,
  query: '',

  async init() {
    const sessions = await transport.listSessions()
    set({ sessions })
    const first = sessions[0]
    if (first) await get().select(first.id)
    else set({ loading: false })
  },

  async select(id) {
    set({ loading: true, activeId: id })
    const state = await transport.openSession(id)
    set({
      activeId: state.session.id,
      messages: state.messages,
      scene: state.scene,
      graph: state.graph,
      loading: false,
    })
  },

  setQuery: (query) => set({ query }),

  async createSession() {
    const session = await transport.createSession({
      title: 'Без названия',
      project: 'Черновики',
      engine: 'rhino',
    })
    set((s) => ({ sessions: [session, ...s.sessions] }))
    await get().select(session.id)
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

      case 'scene-patch':
        set({ scene: event.nodes })
        break

      case 'message-end':
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === event.messageId ? { ...m, streaming: false } : m,
          ),
        }))
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

  toggleNodeVisible: (id) =>
    set((s) => ({
      scene: s.scene.map((n) => (n.id === id ? { ...n, visible: !n.visible } : n)),
    })),

  toggleNodeLocked: (id) =>
    set((s) => ({
      scene: s.scene.map((n) => (n.id === id ? { ...n, locked: !n.locked } : n)),
    })),

  setGraph(doc) {
    set({ graph: doc })
    const id = get().activeId
    if (id) void transport.saveGraph(id, doc)
  },
}))

/** Активная сессия целиком — нужна топбару и статусбару. */
export function useActiveSession(): Session | null {
  return useSession((s) => s.sessions.find((x) => x.id === s.activeId) ?? null)
}
