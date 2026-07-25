import { create } from 'zustand'

export type DisplayMode = 'shaded' | 'wire' | 'clay' | 'xray'
export type Projection = 'persp' | 'ortho'
export type PartId = 'core' | 'slabs' | 'diagrid' | 'glass'

/**
 * Параметры демонстрационной модели — той самой башни с диагридом из фикстур.
 * Инспектор справа правит их напрямую, вьюпорт пересобирается: связь панелей
 * видна сразу, ещё до появления реального движка.
 */
export interface TowerParams {
  /** Этажей. */
  floors: number
  /** Шаг этажа, мм. */
  floorHeight: number
  /** Полное кручение по высоте, °. */
  twistDeg: number
  /** Радиус описанной окружности плана, мм. */
  radius: number
  /** Сторон плана (и рёбер диагрида). */
  sides: number
  /** Сечение ребра, мм. */
  ribSize: number
}

export interface ViewStats {
  fps: number
  triangles: number
  objects: number
}

export type PartFlags = Record<PartId, boolean>

const NO_FLAGS: PartFlags = { core: false, slabs: false, diagrid: false, glass: false }

interface ViewportState {
  mode: DisplayMode
  projection: Projection
  grid: boolean
  gizmo: boolean
  selected: PartId | null
  params: TowerParams
  stats: ViewStats
  /** Скрытые и заблокированные части — ими управляет аутлайнер. */
  hidden: PartFlags
  locked: PartFlags
  /** Имя файла, брошенного во вьюпорт. */
  droppedName: string | null
  fitToken: number

  setMode: (mode: DisplayMode) => void
  setProjection: (p: Projection) => void
  toggleGrid: () => void
  toggleGizmo: () => void
  select: (part: PartId | null) => void
  setParam: <K extends keyof TowerParams>(key: K, value: TowerParams[K]) => void
  setStats: (stats: Partial<ViewStats>) => void
  setDropped: (name: string | null) => void
  fit: () => void
  toggleHidden: (part: PartId) => void
  toggleLocked: (part: PartId) => void
}

export const useViewport = create<ViewportState>()((set) => ({
  mode: 'shaded',
  projection: 'persp',
  grid: true,
  gizmo: true,
  selected: null,
  params: {
    floors: 24,
    floorHeight: 3600,
    twistDeg: 18,
    radius: 11000,
    sides: 6,
    ribSize: 700,
  },
  stats: { fps: 0, triangles: 0, objects: 0 },
  hidden: NO_FLAGS,
  locked: NO_FLAGS,
  droppedName: null,
  fitToken: 0,

  setMode: (mode) => set({ mode }),
  setProjection: (projection) => set({ projection }),
  toggleGrid: () => set((s) => ({ grid: !s.grid })),
  toggleGizmo: () => set((s) => ({ gizmo: !s.gizmo })),
  select: (selected) => set({ selected }),

  setParam: (key, value) =>
    set((s) => ({ params: { ...s.params, [key]: clampParam(key, value) } })),

  setStats: (stats) => set((s) => ({ stats: { ...s.stats, ...stats } })),
  setDropped: (droppedName) => set({ droppedName }),
  fit: () => set((s) => ({ fitToken: s.fitToken + 1 })),

  toggleHidden: (part) =>
    set((s) => {
      const hidden = { ...s.hidden, [part]: !s.hidden[part] }
      // Скрытую часть снимаем с выделения — иначе инспектор показывает невидимое.
      return { hidden, selected: hidden[part] && s.selected === part ? null : s.selected }
    }),

  toggleLocked: (part) =>
    set((s) => {
      const locked = { ...s.locked, [part]: !s.locked[part] }
      return { locked, selected: locked[part] && s.selected === part ? null : s.selected }
    }),
}))

/** Держим параметры в диапазонах, при которых сцена остаётся вменяемой. */
function clampParam<K extends keyof TowerParams>(key: K, value: TowerParams[K]): TowerParams[K] {
  const limits: Record<keyof TowerParams, [number, number]> = {
    floors: [1, 80],
    floorHeight: [2400, 8000],
    twistDeg: [-180, 180],
    radius: [3000, 40000],
    sides: [3, 12],
    ribSize: [100, 2000],
  }
  const [min, max] = limits[key]
  const n = Math.round(Number(value))
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)) as TowerParams[K]
}
