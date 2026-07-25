import type { EngineDescriptor, EngineId, ModelProvider } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'

interface EngineState {
  engines: EngineDescriptor[]
  providers: ModelProvider[]
  boundEngine: EngineId
  load: () => Promise<void>
  bind: (id: EngineId) => void
}

export const useEngines = create<EngineState>()((set) => ({
  engines: [],
  providers: [],
  boundEngine: 'rhino',

  async load() {
    const [engines, providers] = await Promise.all([
      transport.listEngines(),
      transport.listProviders(),
    ])
    set({ engines, providers })
  },

  bind: (boundEngine) => set({ boundEngine }),
}))
