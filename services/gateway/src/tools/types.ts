import type { EngineId } from '@complex/protocol'

/**
 * Описание инструмента, который получает модель.
 *
 * Схема параметров — обычный JSON Schema: именно его ждёт поле `parameters` у
 * функции в OpenAI-совместимом API, так что перекладывать ничего не нужно.
 */
export interface ToolDef {
  /** Имя для модели. Префикс движка обязателен: su_ / rh_ / bl_. */
  name: string
  /** Движок, без которого инструмент бесполезен. */
  engine: EngineId
  /** Что делает — читает модель, поэтому по-русски и по делу. */
  description: string
  parameters: JsonSchema
  /**
   * Команда моста. Для SketchUp это путь HTTP-маршрута, для Rhino и Blender —
   * имя команды в их протоколе.
   */
  command: string
  /**
   * Выбор команды по аргументам — для случаев, когда одному инструменту модели
   * соответствует несколько команд моста. Например булевы операции в Rhino: у
   * плагина это три отдельные команды, а модели удобнее одна с перечислением.
   */
  resolveCommand?: (args: Record<string, unknown>) => string
  /**
   * Преобразование аргументов модели в параметры моста. Задано не у всех:
   * там, где имена совпадают, аргументы уходят как есть.
   */
  mapParams?: (args: Record<string, unknown>) => Record<string, unknown>
}

export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: JsonSchemaProperty
  minItems?: number
  maxItems?: number
  default?: unknown
  properties?: Record<string, JsonSchemaProperty>
}

/** Точка в миллиметрах — повторяется в схемах слишком часто, чтобы дублировать. */
export const POINT_MM: JsonSchemaProperty = {
  type: 'array',
  description: 'Точка [x, y, z] в миллиметрах',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
}

export const VECTOR: JsonSchemaProperty = {
  type: 'array',
  description: 'Вектор [x, y, z]',
  items: { type: 'number' },
  minItems: 3,
  maxItems: 3,
}
