import * as THREE from 'three'
import type { TowerParams } from '../store/viewport'

/** Пайплайн считает в миллиметрах, three — в метрах. */
export const MM = 0.001

/** Толщина перекрытия, мм. */
export const SLAB_THICKNESS = 260

/**
 * Кольцо плана на этаже `floor`.
 *
 * Точки задаются как (sin, cos), а не (cos, sin), чтобы совпасть с разбивкой
 * `CylinderGeometry` в three: тогда плиту достаточно инстансить с поворотом
 * вокруг Y на угол кручения, и рёбра диагрида точно попадают в её углы.
 */
export function towerRing(p: TowerParams, floor: number): THREE.Vector3[] {
  const twist = ((p.twistDeg * Math.PI) / 180) * (p.floors > 0 ? floor / p.floors : 0)
  const y = floor * p.floorHeight * MM
  const r = p.radius * MM
  const pts: THREE.Vector3[] = []
  for (let k = 0; k < p.sides; k++) {
    const a = (2 * Math.PI * k) / p.sides + twist
    pts.push(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r))
  }
  return pts
}

/** Угол кручения на этаже — им же поворачиваются инстансы плит. */
export function twistAt(p: TowerParams, floor: number): number {
  return ((p.twistDeg * Math.PI) / 180) * (p.floors > 0 ? floor / p.floors : 0)
}

export function towerHeight(p: TowerParams): number {
  return p.floors * p.floorHeight * MM
}

/** Витраж: закрученная призматическая оболочка между кольцами этажей. */
export function buildSkin(p: TowerParams): THREE.BufferGeometry {
  const rings: THREE.Vector3[][] = []
  for (let f = 0; f <= p.floors; f++) rings.push(towerRing(p, f))

  const pos: number[] = []
  const push = (v: THREE.Vector3) => pos.push(v.x, v.y, v.z)

  for (let f = 0; f < p.floors; f++) {
    const lo = rings[f]
    const hi = rings[f + 1]
    for (let k = 0; k < p.sides; k++) {
      const k2 = (k + 1) % p.sides
      // квад разбиваем на два треугольника, обход наружу
      push(lo[k])
      push(hi[k])
      push(hi[k2])
      push(lo[k])
      push(hi[k2])
      push(lo[k2])
    }
  }

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

/**
 * Матрицы рёбер диагрида: от вершины k на этаже f к вершинам k±1 на этаже f+2.
 * Базовая геометрия ребра — единичный по Y брусок, длина задаётся масштабом.
 */
export function buildRibMatrices(p: TowerParams): THREE.Matrix4[] {
  const up = new THREE.Vector3(0, 1, 0)
  const out: THREE.Matrix4[] = []
  const step = 2

  for (let f = 0; f + step <= p.floors; f += step) {
    const lo = towerRing(p, f)
    const hi = towerRing(p, f + step)
    for (let k = 0; k < p.sides; k++) {
      for (const dk of [1, -1]) {
        const a = lo[k]
        const b = hi[(k + dk + p.sides) % p.sides]
        const dir = new THREE.Vector3().subVectors(b, a)
        const len = dir.length()
        if (len < 1e-6) continue

        const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize())
        const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5)
        out.push(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, len, 1)))
      }
    }
  }
  return out
}

/** Матрицы перекрытий: та же призма, повёрнутая на угол кручения этажа. */
export function buildSlabMatrices(p: TowerParams, thickness: number): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = []
  for (let f = 0; f <= p.floors; f++) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), twistAt(p, f))
    const pos = new THREE.Vector3(0, f * p.floorHeight * MM, 0)
    out.push(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, thickness, 1)))
  }
  return out
}
