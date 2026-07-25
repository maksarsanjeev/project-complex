import type { ChatMessage, ProviderTransport } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'
import { useSession } from './session'

interface ChatState {
  draft: string
  /** Как подключена модель: прямой вызов по ключу или локальный CLI-агент. */
  mode: ProviderTransport
  modelId: string
  sending: boolean

  setDraft: (draft: string) => void
  setMode: (mode: ProviderTransport) => void
  setModelId: (id: string) => void
  send: () => Promise<void>
  stop: () => void
}

let cancelled = false

export const useChat = create<ChatState>()((set, get) => ({
  draft: '',
  mode: 'api',
  modelId: 'claude-opus-5-api',
  sending: false,

  setDraft: (draft) => set({ draft }),
  setMode: (mode) => set({ mode }),
  setModelId: (modelId) => set({ modelId }),

  async send() {
    const text = get().draft.trim()
    const sessionId = useSession.getState().activeId
    if (!text || !sessionId || get().sending) return

    const user: ChatMessage = {
      id: `u-${Date.now().toString(36)}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    useSession.getState().pushMessage(user)
    set({ draft: '', sending: true })

    cancelled = false
    try {
      for await (const event of transport.sendMessage({
        sessionId,
        text,
        modelId: get().modelId,
      })) {
        if (cancelled) break
        useSession.getState().applyChatEvent(event)
      }
    } catch (error) {
      useSession.getState().applyChatEvent({
        type: 'error',
        message: error instanceof Error ? error.message : 'сбой транспорта',
      })
    } finally {
      set({ sending: false })
    }
  },

  stop() {
    cancelled = true
    set({ sending: false })
  },
}))
