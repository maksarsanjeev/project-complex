import type { EngineDescriptor, EngineId, ModelProvider, ParametricMode } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'

interface EngineState {
  engines: EngineDescriptor[]
  providers: ModelProvider[]
  boundEngine: EngineId
  /**
   * Нужна ли параметрика на Grasshopper.
   *
   * Три состояния, а не галочка: при двух отметка человека и вопрос модели
   * противоречат друг другу — отметил «не нужна», а она всё равно спрашивает.
   * «Спросить» это тоже решение, и оно по умолчанию.
   */
  parametric: ParametricMode
  load: () => Promise<void>
  bind: (id: EngineId) => void
  setParametric: (mode: ParametricMode) => void
}

export const useEngines = create<EngineState>()((set) => ({
  engines: [],
  providers: [],
  boundEngine: 'rhino',
  parametric: 'ask',

  async load() {
    const [engines, providers] = await Promise.all([
      transport.listEngines(),
      transport.listProviders(),
    ])
    set({ engines, providers })
  },

  bind: (boundEngine) => set({ boundEngine }),
  setParametric: (parametric) => set({ parametric }),
}))
