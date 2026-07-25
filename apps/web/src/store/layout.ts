import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type CenterTab = 'viewport' | 'nodes'
export type Theme = 'light' | 'dark'

interface LayoutState {
  theme: Theme
  tab: CenterTab
  chatCollapsed: boolean
  railCollapsed: boolean
  toolsCollapsed: boolean

  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  setTab: (tab: CenterTab) => void
  toggleChat: () => void
  toggleRail: () => void
  toggleTools: () => void
}

/** Раскладка переживает перезагрузку — размеры сплиттеров хранит сама библиотека. */
export const useLayout = create<LayoutState>()(
  persist(
    (set) => ({
      theme: 'light',
      tab: 'viewport',
      chatCollapsed: false,
      railCollapsed: false,
      toolsCollapsed: false,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === 'light' ? 'dark' : 'light' })),
      setTab: (tab) => set({ tab }),
      toggleChat: () => set((s) => ({ chatCollapsed: !s.chatCollapsed })),
      toggleRail: () => set((s) => ({ railCollapsed: !s.railCollapsed })),
      toggleTools: () => set((s) => ({ toolsCollapsed: !s.toolsCollapsed })),
    }),
    { name: 'complex.layout' },
  ),
)

/** Тема живёт атрибутом на <html> — все стили читают только токены. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}
