/**
 * Генератор набора инструментов Blender из схем самого моста.
 *
 * Схемы руками не пишем. Придуманная по документации схема `gh_apply_graph`
 * стоила дня диагностики: модель вызывала инструмент, плагин отвечал, что
 * аргументы не те, а выглядело это как «модель игнорирует Grasshopper».
 * Здесь контракт берётся у источника — сервер сам говорит, что он ждёт.
 *
 * Запуск: node scripts/gen-blender-tools.mjs (мост должен быть поднят).
 */
import { writeFileSync } from 'node:fs'

const URL_MCP = process.env.BLENDER_MCP_URL ?? 'http://127.0.0.1:8000/mcp'

let id = 0
let session = null

async function post(body, notify = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (session) headers['mcp-session-id'] = session
  const response = await fetch(URL_MCP, { method: 'POST', headers, body: JSON.stringify(body) })
  const issued = response.headers.get('mcp-session-id')
  if (issued) session = issued
  if (notify) return null
  const text = await response.text()
  const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text
  return JSON.parse(line.replace(/^data:\s*/, ''))
}

/**
 * Что публикуем модели. Остальные полторы сотни не выброшены, а не выданы:
 * описания оплачиваются на каждом круге, а нужны они редко.
 */
const KEEP = [
  'scene_context', 'scene_list_objects', 'scene_clean_scene', 'scene_delete_object',
  'scene_rename_object', 'scene_get_bounding_box', 'scene_get_viewport',
  'scene_measure_dimensions', 'scene_measure_gap', 'scene_assert_dimensions', 'scene_assert_contact',
  'modeling_create_primitive', 'modeling_transform_object', 'modeling_add_modifier',
  'modeling_apply_modifier', 'modeling_join_objects', 'modeling_set_origin',
  'mesh_boolean', 'mesh_extrude_region', 'mesh_bevel', 'mesh_inset', 'mesh_loop_cut',
  'mesh_subdivide', 'mesh_smooth', 'mesh_mirror', 'mesh_spin', 'mesh_select',
  'curve_create', 'curve_to_mesh',
  'material_create', 'material_assign',
  'extraction_render_angles',
  'system_save_file', 'system_new_file', 'system_undo',
  'export_glb', 'export_obj',
]

await post({
  jsonrpc: '2.0', id: ++id, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'complex', version: '0.1' } },
})
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true)

const all = (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/list', params: {} })).result.tools
const picked = KEEP.map((n) => all.find((t) => t.name === n)).filter(Boolean)
const missing = KEEP.filter((n) => !all.some((t) => t.name === n))

console.log(`отобрано ${picked.length} из ${all.length}`)
if (missing.length) console.log('не найдены:', missing.join(', '))

const quote = (s) => JSON.stringify(String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 420))

const body = picked
  .map((t) => [
    '  {',
    `    name: 'bl_${t.name}',`,
    "    engine: 'blender',",
    `    command: 'bl:${t.name}',`,
    `    description: ${quote(t.description)},`,
    `    parameters: ${JSON.stringify(t.inputSchema ?? { type: 'object', properties: {} })} as unknown as JsonSchema,`,
    '  },',
  ].join('\n'))
  .join('\n')

const header = [
  "import type { JsonSchema, ToolDef } from './types.ts'",
  '',
  '/**',
  ' * Инструменты Blender через мост blender-ai-mcp.',
  ' *',
  ' * ФАЙЛ СГЕНЕРИРОВАН из ответа самого сервера — схемы не написаны руками, и это',
  ' * принципиально. Придуманная по документации схема gh_apply_graph стоила дня:',
  ' * модель вызывала инструмент, плагин отвечал, что аргументы не те, а выглядело',
  ' * это как «модель игнорирует Grasshopper». Здесь контракт взят у источника.',
  ' *',
  ` * Отобрано ${picked.length} инструментов из ${all.length}. Остальные не выброшены, а не`,
  ' * опубликованы: их описания оплачивались бы на каждом круге, а нужны редко.',
  ' * Перегенерировать: node scripts/gen-blender-tools.mjs',
  ' */',
  'export const BLENDER_AI_TOOLS: ToolDef[] = [',
].join('\n')

writeFileSync('services/gateway/src/tools/blenderAi.ts', `${header}\n${body}\n]\n`)
console.log('файл записан')
