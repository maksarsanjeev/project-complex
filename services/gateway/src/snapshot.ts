import type { EngineId, ModelSnapshot } from '@complex/protocol'
import * as agents from './agents.ts'
import { nowIso } from './db/db.ts'
import * as repo from './db/repo.ts'
import { rhinoScript } from './tools/scripts.ts'

/**
 * Забор модели из движка — в одном месте, потому что зовут его из двух.
 *
 * Раньше это жило внутри обработчика `pullModel`, и кнопка «забрать модель»
 * была единственным способом. Теперь снимок нужен ещё и посреди работы модели:
 * на чекпойнте итерации человек должен увидеть во вьюпорте то, о чём его
 * спрашивают. Копировать ради этого разбор ответа Rhino было бы приглашением
 * однажды поправить одну копию из двух.
 */

/**
 * Приставка движка к идентификаторам узлов: `su:ent:43725`.
 *
 * Один проект бывает открыт сразу в трёх приложениях, а номера объектов у всех
 * свои и начинаются с малых чисел — без приставки они бы столкнулись, и клик
 * по группе SketchUp выделял бы слой Rhino.
 */
export const PREFIX: Record<EngineId, string> = { sketchup: 'su', rhino: 'rh', blender: 'bl' }

/**
 * Чем спросить снимок у каждого движка.
 *
 * У SketchUp это наш собственный маршрут: мост писали мы, и он сразу отдаёт
 * готовую структуру. У Rhino команда наша, а не плагина: агент выполнит скрипт
 * и прочитает файл, который тот напишет. Через печать плагина такой объём не
 * проходит.
 */
function snapshotCall(engine: EngineId): { command: string; params: Record<string, unknown> } {
  if (engine === 'rhino') {
    return { command: 'complex_snapshot', params: { code: rhinoScript('snapshot.py') } }
  }
  if (engine === 'blender') {
    // Геометрия забирается экспортом в glb: он отдаёт меши, иерархию и
    // материалы одним куском, а разбирать его наш вьюпорт уже умеет.
    // Агент выполнит экспорт и прочитает файл сам — как и у Rhino.
    return { command: 'complex_snapshot_blender', params: {} }
  }

  return { command: 'GET /model/mesh', params: {} }
}

function parseSnapshot(engine: EngineId, raw: unknown): Record<string, unknown> {
  if (engine !== 'rhino') return raw as Record<string, unknown>

  // Агент отдаёт уже разобранный файл. Пустота здесь означает, что снимок не
  // дошёл, а не что модель пуста, — и сказать об этом надо словами.
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { nodes?: unknown }).nodes)) {
    throw new Error('Снимок Rhino не дошёл: агент вернул не структуру документа')
  }
  return raw as Record<string, unknown>
}

function namespace(snapshot: ModelSnapshot, engine: EngineId): ModelSnapshot {
  const p = PREFIX[engine]
  const id = (raw: string): string => `${p}:${raw}`

  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({
      ...node,
      id: id(node.id),
      parentId: node.parentId ? id(node.parentId) : null,
      engine,
    })),
    parts: snapshot.parts.map((part) => ({ ...part, nodeId: id(part.nodeId) })),
    selection: snapshot.selection?.map(id),
    // Теги, материалы и определения тоже адресуемы: их переименовывают так же,
    // как объекты, и идентификатор нужен по той же причине — имена в разных
    // движках совпадают, «Бетон» есть и в SketchUp, и в Rhino.
    tags: snapshot.tags?.map((x) => ({ ...x, id: id(`tag:${x.name}`) })),
    materials: snapshot.materials?.map((x) => ({ ...x, id: id(`material:${x.name}`) })),
    definitions: snapshot.definitions?.map((x) => ({ ...x, id: id(`definition:${x.name}`) })),
  }
}

/** Обратно: из `su:ent:43725` в движок и его собственный идентификатор. */
export function denamespace(nodeId: string): { engine: EngineId; id: string } | null {
  const [prefix, ...rest] = nodeId.split(':')
  const engine = (Object.keys(PREFIX) as EngineId[]).find((e) => PREFIX[e] === prefix)
  return engine ? { engine, id: rest.join(':') } : null
}

/**
 * Снять модель и, если названа сессия, положить снимок в неё.
 *
 * Движок не запущен — возвращаем null, а не бросаем ошибку: это обычное
 * состояние, и веб-морда должна просто показать пустую сцену.
 */
export async function takeSnapshot(
  engine: EngineId,
  instance?: string,
  sessionId?: string,
): Promise<ModelSnapshot | null> {
  if (!agents.isOnline(engine)) return null

  const answer = await agents.invoke({ engine, instance, ...snapshotCall(engine) })
  const raw = parseSnapshot(engine, answer) as unknown as Omit<
    ModelSnapshot,
    'engine' | 'instance' | 'takenAt'
  >

  const snapshot = namespace({ ...raw, engine, instance, takenAt: nowIso() }, engine)

  // Кладём снимок в ту сессию, в которой работали. Иначе он один на всё
  // приложение, и открыв другой проект, человек видит чужую модель.
  if (sessionId) repo.saveSnapshot(sessionId, snapshot)

  return snapshot
}
