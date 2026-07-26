import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { create } from 'zustand'

/** Габарит, к которому нормируем брошенную во вьюпорт модель, м. */
const TARGET_SIZE = 60

const decoder = new TextDecoder()

async function parse(file: File): Promise<THREE.Object3D> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const buffer = await file.arrayBuffer()

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const gltf = await new GLTFLoader().parseAsync(
        ext === 'glb' ? buffer : decoder.decode(buffer),
        '',
      )
      return gltf.scene
    }
    case 'obj':
      return new OBJLoader().parse(decoder.decode(buffer))
    case 'stl': {
      const geometry = new STLLoader().parse(buffer)
      geometry.computeVertexNormals()
      return new THREE.Mesh(geometry)
    }
    default:
      throw new Error(`формат .${ext} пока не читаем`)
  }
}

/** Центрируем по XZ, сажаем на землю и нормируем масштаб — иначе камера промахивается. */
function normalize(object: THREE.Object3D): THREE.Object3D {
  const box = new THREE.Box3().setFromObject(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const largest = Math.max(size.x, size.y, size.z)
  const scale = largest > 0 ? TARGET_SIZE / largest : 1

  const root = new THREE.Group()
  object.position.set(-center.x, -box.min.y, -center.z)
  root.add(object)
  root.scale.setScalar(scale)
  return root
}

/**
 * Габарит загруженной модели в единицах сцены — по нему камера выбирает
 * расстояние.
 *
 * Без него камера пользовалась зашитыми числами, годными для перетащенного
 * файла: тот масштабируется под стандартный размер, и «примерно 60 на 30»
 * работало. Снимок из движка не масштабируется намеренно — иначе миллиметры
 * во вьюпорте перестали бы быть миллиметрами, — и модель высотой полтора метра
 * оказывалась точкой в кадре, рассчитанном на башню.
 */
export interface ModelBounds {
  height: number
  radius: number
  /**
   * Настоящий центр геометрии, а не точка над началом координат.
   *
   * Модель из движка почти никогда не стоит в нуле: пользователь строит там,
   * где ему удобно. Целясь в ноль, камера показывает модель в углу кадра —
   * или не показывает вовсе, если её унесло далеко.
   */
  center: THREE.Vector3
}

function measure(object: THREE.Object3D): ModelBounds {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return { height: 1, radius: 1, center: new THREE.Vector3() }
  const size = box.getSize(new THREE.Vector3())
  return {
    height: Math.max(size.y, 0.001),
    radius: Math.max(Math.hypot(size.x, size.z) / 2, 0.001),
    center: box.getCenter(new THREE.Vector3()),
  }
}

interface LoadedState {
  object: THREE.Object3D | null
  name: string | null
  bounds: ModelBounds | null
  loading: boolean
  error: string | null
  load: (file: File) => Promise<void>
  clear: () => void
}

/** Загруженная пользователем модель живёт отдельно от параметров демо-башни. */
export const useLoadedModel = create<LoadedState>()((set, get) => ({
  object: null,
  name: null,
  bounds: null,
  loading: false,
  error: null,

  async load(file) {
    set({ loading: true, error: null })
    try {
      const object = normalize(await parse(file))
      get().object?.traverse(disposeNode)
      set({ object, name: file.name, bounds: measure(object), loading: false })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'не удалось прочитать файл',
      })
    }
  },

  clear() {
    get().object?.traverse(disposeNode)
    set({ object: null, name: null, bounds: null, error: null })
  },
}))

function disposeNode(node: THREE.Object3D): void {
  const mesh = node as THREE.Mesh
  mesh.geometry?.dispose()
  const material = mesh.material
  if (Array.isArray(material)) material.forEach((m) => m.dispose())
  else material?.dispose()
}
