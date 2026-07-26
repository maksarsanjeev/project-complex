import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type DisplayMode = 'shaded' | 'wire' | 'clay' | 'xray'
export type Projection = 'persp' | 'ortho'
/**
 * Идентификатор части сцены.
 *
 * У демо-башни это четыре известных имени, у настоящей модели — идентификаторы
 * узлов из движка (`ent:43523`, `layer:бетон`). Поэтому строка, а не
 * перечисление: видимость и блокировка должны работать одинаково и там и там.
 */
export type PartId = string

/** Имена частей демо-башни — они же значения PartId для неё. */
export const DEMO_PARTS = ['core', 'slabs', 'diagrid', 'glass'] as const

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
  /**
   * Что выделено. Список, а не одна часть: с несколькими объектами работают
   * не реже, чем с одним, — назначить материал группе деталей, подвинуть
   * набор, удалить лишнее. Выделение уходит модели вместе с сообщением,
   * поэтому «примени это ко всем выделенным» должно быть выразимо.
   */
  selected: PartId[]
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
  /** Выделить одну часть. `additive` — добавить к уже выделенному. */
  select: (part: PartId | null, additive?: boolean) => void
  /** Выделить сразу набор — например все части слоя. */
  selectMany: (parts: PartId[]) => void
  setParam: <K extends keyof TowerParams>(key: K, value: TowerParams[K]) => void
  setStats: (stats: Partial<ViewStats>) => void
  setDropped: (name: string | null) => void
  fit: () => void
  toggleHidden: (part: PartId) => void
  toggleLocked: (part: PartId) => void
}

/**
 * Настройки вьюпорта и параметры модели переживают перезагрузку.
 *
 * Сейчас они общие на приложение. Когда появится gateway, параметры модели
 * переедут в состояние сессии и будут храниться на сервере — у каждой сессии
 * своя модель.
 */
export const useViewport = create<ViewportState>()(
  persist(
    (set) => ({
      mode: 'shaded',
      projection: 'persp',
      grid: true,
      gizmo: true,
      selected: [],
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
      select: (part, additive = false) =>
        set((s) => {
          if (part === null) return { selected: [] }
          if (!additive) return { selected: s.selected.includes(part) && s.selected.length === 1 ? [] : [part] }
          return {
            selected: s.selected.includes(part)
              ? s.selected.filter((x) => x !== part)
              : [...s.selected, part],
          }
        }),

      selectMany: (parts) => set({ selected: parts }),

      setParam: (key, value) =>
        set((s) => ({ params: { ...s.params, [key]: clampParam(key, value) } })),

      setStats: (stats) => set((s) => ({ stats: { ...s.stats, ...stats } })),
      setDropped: (droppedName) => set({ droppedName }),
      fit: () => set((s) => ({ fitToken: s.fitToken + 1 })),

      toggleHidden: (part) =>
        set((s) => {
          const hidden = { ...s.hidden, [part]: !s.hidden[part] }
          // Скрытую часть снимаем с выделения — иначе инспектор показывает невидимое.
          return { hidden, selected: hidden[part] ? s.selected.filter((x) => x !== part) : s.selected }
        }),

      toggleLocked: (part) =>
        set((s) => {
          const locked = { ...s.locked, [part]: !s.locked[part] }
          return { locked, selected: locked[part] ? s.selected.filter((x) => x !== part) : s.selected }
        }),
    }),
    {
      name: 'complex.viewport',
      // Сохраняем настройки и модель; измеренное и сиюминутное — нет.
      partialize: (s) => ({
        mode: s.mode,
        projection: s.projection,
        grid: s.grid,
        gizmo: s.gizmo,
        params: s.params,
        hidden: s.hidden,
        locked: s.locked,
      }),
    },
  ),
)

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
