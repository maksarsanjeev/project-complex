import type { ChatMessage, ProviderTransport, SelectionRef } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'
import { mergedNodes, useModel } from './model'
import { useViewport } from './viewport'
import { useSession } from './session'

interface ChatState {
  /**
   * Варианты ответа на заданный моделью вопрос — станут кнопками под вводом.
   * Живут до следующего сообщения: ответил — выбор снят.
   */
  pendingOptions: string[]
  /**
   * Расход по текущей сессии. Складывается по ходам: стоимость проекта видно
   * сразу, а не в конце месяца по счёту.
   */
  spent: { prompt: number; completion: number; cached: number; cost: number }
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
  setPendingOptions: (options: string[]) => void
  addUsage: (u: { prompt: number; completion: number; cached: number; cost?: number }) => void
  resetUsage: () => void
}

let cancelled = false

export const useChat = create<ChatState>()((set, get) => ({
  pendingOptions: [],
  spent: { prompt: 0, completion: 0, cached: 0, cost: 0 },
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
    set({ draft: '', sending: true, pendingOptions: [] })

    cancelled = false
    try {
      for await (const event of transport.sendMessage({
        sessionId,
        text,
        modelId: get().modelId,
        selection: currentSelection(),
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
      // Модель закончила ход — подтягиваем геометрию из движка. Именно здесь,
      // а не по таймеру: сборка меша идёт на главном потоке SketchUp, и опрос
      // по расписанию дёргал бы его интерфейс даже когда ничего не менялось.
      // Ошибку глотаем намеренно: движок мог закрыться посреди разговора, и
      // ронять из-за этого ответ модели незачем — он уже получен.
      void useModel.getState().pull().catch(() => {})
    }
  },

  stop() {
    cancelled = true
    set({ sending: false })
  },

  setPendingOptions: (pendingOptions) => set({ pendingOptions }),

  addUsage: (u) =>
    set((s) => ({
      spent: {
        prompt: s.spent.prompt + u.prompt,
        completion: s.spent.completion + u.completion,
        cached: s.spent.cached + u.cached,
        cost: s.spent.cost + (u.cost ?? 0),
      },
    })),

  resetUsage: () => set({ spent: { prompt: 0, completion: 0, cached: 0, cost: 0 } }),
}))

/**
 * Что выделено во вьюпорте — уходит вместе с сообщением.
 *
 * Без этого фраза «измени выделенный объект» не значит для модели ничего:
 * выделение живёт в браузере и до сервера не доходило. Ищем в том же дереве,
 * что показывает аутлайнер, — тогда имя и слой совпадают с тем, что человек
 * видит на экране.
 */
function currentSelection(): SelectionRef[] | undefined {
  const ids = useViewport.getState().selected
  if (!ids.length) return undefined

  const snapshots = useModel.getState().snapshots
  if (!snapshots.length) return undefined

  const nodes = mergedNodes(snapshots)
  const refs = ids
    .map((id) => nodes.find((n) => n.id === id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .map((node) => {
      const parent = nodes.find((n) => n.id === node.parentId)
      return {
        id: node.id,
        name: node.name,
        kind: node.kind,
        layer: node.kind === 'layer' ? node.name : parent?.name,
      }
    })

  return refs.length ? refs : undefined
}
