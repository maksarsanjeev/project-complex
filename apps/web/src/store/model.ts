import type { EngineId, ModelSnapshot, SceneNode } from '@complex/protocol'
import * as THREE from 'three'
import { create } from 'zustand'
import { transport } from '../api/transport'
import { useLoadedModel } from '../viewport/loader'

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
 */

/** Миллиметры сцены → единицы вьюпорта. Демо-башня живёт в тех же единицах. */
const MM = 0.001

interface ModelState {
  snapshot: ModelSnapshot | null
  loading: boolean
  error: string | null
  /** Забрать модель из движка. Тихо ничего не делает, если движок не запущен. */
  pull: (engine?: EngineId) => Promise<void>
  clear: () => void
}

export const useModel = create<ModelState>()((set) => ({
  snapshot: null,
  loading: false,
  error: null,

  async pull(engine = 'sketchup') {
    set({ loading: true, error: null })
    try {
      const snapshot = await transport.pullModel({ engine })
      if (!snapshot) {
        // Движок не запущен — это не ошибка, а обычное состояние.
        set({ snapshot: null, loading: false })
        useLoadedModel.getState().clear()
        return
      }
      useLoadedModel.getState().setObject(buildObject(snapshot), snapshot.title)
      set({ snapshot, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'не удалось забрать модель',
      })
    }
  },

  clear() {
    useLoadedModel.getState().clear()
    set({ snapshot: null, error: null })
  },
}))

/**
 * Собирает объект three.js из снимка.
 *
 * Одна часть — один узел дерева, поэтому спрятать группу в аутлайнере можно
 * будет по имени объекта, не пересобирая геометрию.
 */
function buildObject(snapshot: ModelSnapshot): THREE.Object3D {
  const root = new THREE.Group()
  root.name = 'модель'

  for (const part of snapshot.parts) {
    const geometry = new THREE.BufferGeometry()
    // Координаты приходят в миллиметрах: масштабируем один раз здесь, чтобы
    // дальше по сцене везде были одни и те же единицы.
    const positions = Float32Array.from(part.positions, (v) => v * MM)
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    if (part.normals.length === part.positions.length) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(part.normals, 3))
    } else {
      geometry.computeVertexNormals()
    }
    geometry.computeBoundingSphere()

    const mesh = new THREE.Mesh(geometry)
    mesh.name = part.nodeId
    mesh.userData.layer = part.layer
    root.add(mesh)
  }

  // SketchUp считает Z вверх, three.js — Y. Без поворота модель лежит на боку.
  root.rotation.x = -Math.PI / 2
  return root
}

/** Дерево из снимка — в том же виде, что ждёт аутлайнер. */
export function snapshotTree(snapshot: ModelSnapshot | null): SceneNode[] {
  return snapshot?.nodes ?? []
}
