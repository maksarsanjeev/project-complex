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

interface LoadedState {
  object: THREE.Object3D | null
  name: string | null
  loading: boolean
  error: string | null
  load: (file: File) => Promise<void>
  clear: () => void
}

/** Загруженная пользователем модель живёт отдельно от параметров демо-башни. */
export const useLoadedModel = create<LoadedState>()((set, get) => ({
  object: null,
  name: null,
  loading: false,
  error: null,

  async load(file) {
    set({ loading: true, error: null })
    try {
      const object = normalize(await parse(file))
      get().object?.traverse(disposeNode)
      set({ object, name: file.name, loading: false })
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'не удалось прочитать файл',
      })
    }
  },

  clear() {
    get().object?.traverse(disposeNode)
    set({ object: null, name: null, error: null })
  },
}))

function disposeNode(node: THREE.Object3D): void {
  const mesh = node as THREE.Mesh
  mesh.geometry?.dispose()
  const material = mesh.material
  if (Array.isArray(material)) material.forEach((m) => m.dispose())
  else material?.dispose()
}
