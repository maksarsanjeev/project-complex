import type { EngineId, ModelSnapshot, SceneNode } from '@complex/protocol'
import { create } from 'zustand'
import { transport } from '../api/transport'
import { useViewport } from './viewport'

/**
 * Настоящая модель из движка.
 *
 * До этого вьюпорт показывал демо-башню, которая генерировалась прямо в
 * браузере и была одинаковой в любой сессии. Теперь геометрия приходит из
 * SketchUp: и треугольники, и дерево слоёв — одним снимком.
 *
 * Снимок берётся ПО СОБЫТИЮ, а не по таймеру: после каждого ответа модели и
 * по кнопке. Опрашивать движок постоянно нельзя — сборка меша идёт на главном
 * потоке SketchUp, и на тяжёлой сцене это дёргало бы интерфейс самого SketchUp
 * каждые несколько секунд.
 *
 * Здесь хранится только СНИМОК, без объектов three.js. Сцену из него строит
 * вьюпорт обычными средствами r3f — иначе мимо модели проходят режимы
 * отображения, выделение и видимость, которые живут в компонентах сцены.
 */

/** Миллиметры снимка → единицы сцены. Демо-башня живёт в тех же единицах. */
export const MM = 0.001

/** Габарит для камеры — уже в единицах сцены и в её системе координат. */
export interface SnapshotBounds {
  height: number
  radius: number
  center: [number, number, number]
}

interface ModelState {
  snapshot: ModelSnapshot | null
  bounds: SnapshotBounds | null
  loading: boolean
  error: string | null
  /** Забрать модель из движка. Тихо ничего не делает, если движок не запущен. */
  pull: (engine?: EngineId) => Promise<void>
  clear: () => void
}

export const useModel = create<ModelState>()((set) => ({
  snapshot: null,
  bounds: null,
  loading: false,
  error: null,

  async pull(engine = 'sketchup') {
    set({ loading: true, error: null })
    try {
      const snapshot = await transport.pullModel({ engine })
      // Движок не запущен — это не ошибка, а обычное состояние.
      set({
        snapshot,
        bounds: snapshot ? measure(snapshot) : null,
        loading: false,
      })

      // Выделение, сделанное руками в самом приложении, подхватываем в
      // интерфейс. Иначе человек выделяет в SketchUp, спрашивает «что я
      // выделил» — и получает ответ про другое выделение.
      if (snapshot?.selection?.length) {
        const known = new Set(snapshot.nodes.map((n) => n.id))
        const ids = snapshot.selection.filter((id) => known.has(id))
        if (ids.length) useViewport.getState().selectMany(ids)
      }
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'не удалось забрать модель',
      })
    }
  },

  clear() {
    set({ snapshot: null, bounds: null, error: null })
  },
}))

/**
 * Габаритная коробка снимка, пересчитанная в систему координат сцены.
 *
 * У SketchUp вверх смотрит Z, у three.js — Y, поэтому сцена поворачивается на
 * −90° вокруг X. Тот же поворот применяем и к габариту: иначе камера считала бы
 * высотой глубину модели и наводилась мимо.
 */
function measure(snapshot: ModelSnapshot): SnapshotBounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity

  for (const part of snapshot.parts) {
    const p = part.positions
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] as number
      const y = p[i + 1] as number
      const z = p[i + 2] as number
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
  }

  if (!Number.isFinite(minX)) return { height: 1, radius: 1, center: [0, 0, 0] }

  const sx = (maxX - minX) * MM
  const sy = (maxY - minY) * MM
  const sz = (maxZ - minZ) * MM
  const cx = ((minX + maxX) / 2) * MM
  const cy = ((minY + maxY) / 2) * MM
  const cz = ((minZ + maxZ) / 2) * MM

  return {
    // Вверх в сцене — это Z модели.
    height: Math.max(sz, 0.001),
    radius: Math.max(Math.hypot(sx, sy) / 2, 0.001),
    // Поворот на −90° вокруг X: (x, y, z) → (x, z, −y).
    center: [cx, cz, -cy],
  }
}

/** Дерево из снимка — в том же виде, что ждёт аутлайнер. */
export function snapshotTree(snapshot: ModelSnapshot | null): SceneNode[] {
  return snapshot?.nodes ?? []
}
