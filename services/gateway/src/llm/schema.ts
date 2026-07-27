import { z } from 'zod'
import type { JsonSchema, JsonSchemaProperty } from '../tools/types.ts'

/**
 * JSON Schema наших инструментов → форма Zod, которую ждёт Agent SDK.
 *
 * Почему перевод, а не хранение схем сразу в Zod. Схемы уходят двум разным
 * получателям: OpenRouter принимает JSON Schema как есть, Agent SDK — только
 * Zod. Родной формат тут JSON Schema: он же лежит в контрактах чужих плагинов
 * Rhino, откуда мы их и забираем. Обратный перевод был бы переводом дважды.
 *
 * Поддерживается ровно то подмножество, которое описано в `tools/types.ts`, —
 * больше в наших инструментах не встречается. Неизвестный тип превращается в
 * `z.unknown()`, а не роняет сборку: лучше инструмент с расплывчатым полем,
 * чем движок, у которого пропали все инструменты из-за одной опечатки.
 */
export function toZodShape(schema: JsonSchema): z.ZodRawShape {
  const required = new Set(schema.required ?? [])
  // Собираем в обычную запись: ZodRawShape объявлен только для чтения.
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [name, property] of Object.entries(schema.properties)) {
    let field = toZodType(property)
    if (property.description) field = field.describe(property.description)
    // Необязательное поле помечаем именно так, а не значением по умолчанию:
    // умолчание модель не увидит, а увидит заполненное поле, которого она не
    // просила, — и решит, что уже всё указала.
    shape[name] = required.has(name) ? field : field.optional()
  }

  return shape
}

function toZodType(property: JsonSchemaProperty): z.ZodTypeAny {
  if (property.enum?.length) {
    return z.enum(property.enum as [string, ...string[]])
  }

  switch (property.type) {
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'array': {
      const item = property.items ? toZodType(property.items) : z.unknown()
      let array = z.array(item)
      // minItems/maxItems у нас всегда про точки и векторы: [x, y, z]. Длину
      // стоит проверять именно здесь — иначе ошибка вылезет уже в мосте, где
      // от неё останется только «undefined is not a number».
      if (property.minItems !== undefined) array = array.min(property.minItems)
      if (property.maxItems !== undefined) array = array.max(property.maxItems)
      return array
    }
    case 'object': {
      if (!property.properties) return z.record(z.string(), z.unknown())
      const inner: Record<string, z.ZodTypeAny> = {}
      for (const [name, child] of Object.entries(property.properties)) {
        let field = toZodType(child)
        if (child.description) field = field.describe(child.description)
        inner[name] = field.optional()
      }
      return z.object(inner)
    }
    default:
      return z.unknown()
  }
}
