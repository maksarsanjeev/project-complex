import type { SceneNodeKind } from '@complex/protocol'
import type { PartFlags, PartId, TowerParams } from '../store/viewport'
import { SLAB_THICKNESS } from './geometry'

/**
 * Какие части модели меняет каждый параметр. По этой таблице решается, что
 * запрещено править: замок на части должен защищать её не только от выделения,
 * но и от изменения геометрии.
 */
export const PARAM_PARTS: Record<keyof TowerParams, PartId[]> = {
  floors: ['core', 'slabs', 'diagrid', 'glass'],
  floorHeight: ['core', 'slabs', 'diagrid', 'glass'],
  radius: ['core', 'slabs', 'diagrid', 'glass'],
  sides: ['core', 'slabs', 'diagrid', 'glass'],
  twistDeg: ['slabs', 'diagrid', 'glass'],
  ribSize: ['diagrid'],
}

export const isParamLocked = (key: keyof TowerParams, locked: PartFlags): boolean =>
  PARAM_PARTS[key].some((id) => locked[id])

/**
 * Дерево сцены строится из ТОЙ ЖЕ модели, которую рисует вьюпорт, — поэтому
 * видимость и блокировка в аутлайнере действуют на настоящую геометрию.
 *
 * Когда появится движок, дерево начнёт приходить из `Transport` уже с реальными
 * слоями и материалами файла; форма узлов и вся механика панели не изменятся.
 *
 * Слои названы ПО МАТЕРИАЛУ, а не по функции — так материал назначается одним
 * кликом, и так устроены рабочие файлы проекта.
 */
export interface ScenePart {
  id: PartId
  name: string
  kind: SceneNodeKind
  triangles: number
  /** Габарит в миллиметрах. */
  size: readonly [number, number, number]
}

export interface SceneLayer {
  /** Он же материал: бетон, железо, стекло. */
  material: string
  parts: ScenePart[]
}

/** Треугольников в призме из `sides` граней: боковина плюс две крышки. */
const prismTriangles = (sides: number): number => sides * 4

/** Рёбер диагрида: с каждого чётного этажа по два ребра из каждой вершины. */
export function ribCount(p: TowerParams): number {
  return Math.floor(p.floors / 2) * p.sides * 2
}

export function buildSceneTree(p: TowerParams): SceneLayer[] {
  const height = p.floors * p.floorHeight
  const span = p.radius * 2
  const slabs = p.floors + 1
  const ribs = ribCount(p)

  return [
    {
      material: 'бетон',
      parts: [
        {
          id: 'core',
          name: 'ядро_жёсткости',
          kind: 'solid',
          triangles: prismTriangles(p.sides),
          size: [Math.round(span * 0.34), Math.round(span * 0.34), height],
        },
        {
          id: 'slabs',
          name: `перекрытия_x${slabs}`,
          kind: 'group',
          triangles: prismTriangles(p.sides) * slabs,
          size: [span, span, SLAB_THICKNESS],
        },
      ],
    },
    {
      material: 'железо',
      parts: [
        {
          id: 'diagrid',
          name: 'диагрид_несущий',
          kind: 'group',
          triangles: ribs * 12,
          size: [span, span, height],
        },
      ],
    },
    {
      material: 'стекло',
      parts: [
        {
          id: 'glass',
          name: 'витраж_панели',
          kind: 'surface',
          triangles: p.floors * p.sides * 2,
          size: [span, span, height],
        },
      ],
    },
  ]
}

/** Плоский список частей — удобно для инспектора и подсчёта итогов. */
export function flatParts(tree: SceneLayer[]): ScenePart[] {
  return tree.flatMap((layer) => layer.parts)
}

export function findPart(tree: SceneLayer[], id: PartId): { part: ScenePart; material: string } | null {
  for (const layer of tree) {
    const part = layer.parts.find((x) => x.id === id)
    if (part) return { part, material: layer.material }
  }
  return null
}
