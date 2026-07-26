import type { ModelSnapshot, SceneNodeKind } from '@complex/protocol'
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

/**
 * Плоский список строк дерева с глубиной вложенности.
 *
 * Почему плоский, а не вложенные массивы: вложенность в модели произвольная —
 * группа в группе в компоненте, — и рисовать её рекурсивно значит городить
 * рекурсивный компонент ради отступа. Глубина числом решает то же самое.
 */
export interface SceneRow {
  id: PartId
  name: string
  kind: SceneNodeKind
  depth: number
  triangles: number
  /** Тег объекта — показывается пометкой, а не родительской веткой. */
  tag?: string
  material?: string
  /** Экземпляров у определения; больше одного — правка разойдётся по всем. */
  instances?: number
  size: readonly [number, number, number]
}

/**
 * Строки дерева из настоящей модели — ПО ВЛОЖЕННОСТИ, как в самом SketchUp.
 *
 * Раньше корнем дерева были слои. Это привычно по Rhino и AutoCAD, но в
 * SketchUp неверно: тег там ничего не содержит, он лишь помечает объект.
 * Вложенность даёт только группа или компонент — родной аутлайнер показывает
 * ровно её. Дерево по слоям рисовало структуру, которой в файле нет.
 *
 * Габарит не считаем: снимок его не приносит, а нули вместо размера хуже прочерка.
 */
export function rowsFromSnapshot(snapshot: ModelSnapshot | null): SceneRow[] {
  if (!snapshot) return []

  const rows: SceneRow[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const node of snapshot.nodes) {
      if ((node.parentId ?? null) !== parentId) continue
      rows.push({
        id: node.id,
        name: node.name,
        kind: node.kind,
        depth,
        triangles: node.triangles ?? 0,
        tag: node.tag,
        material: node.material,
        instances: node.instances,
        size: [0, 0, 0] as const,
      })
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

/** Те же строки, но для демо-башни: слой, под ним части. */
export function rowsFromTower(p: TowerParams): SceneRow[] {
  return buildSceneTree(p).flatMap((layer) => [
    {
      id: `layer:${layer.material}`,
      name: layer.material,
      kind: 'layer' as SceneNodeKind,
      depth: 0,
      triangles: layer.parts.reduce((sum, x) => sum + x.triangles, 0),
      size: [0, 0, 0] as const,
    },
    ...layer.parts.map((part) => ({
      id: part.id,
      name: part.name,
      kind: part.kind,
      depth: 1,
      triangles: part.triangles,
      material: layer.material,
      size: part.size,
    })),
  ])
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
