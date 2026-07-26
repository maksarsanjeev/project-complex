import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { SCHEMA } from './schema.ts'

/**
 * Встроенный в Node SQLite. Выбран сознательно вместо better-sqlite3: тот
 * требует компилятор C++ — на Windows установка падает без Visual Studio, а в
 * образ Docker пришлось бы тащить всю сборочную обвязку. Встроенному не нужно
 * ничего нигде, и один и тот же код работает на машине разработчика и на сервере.
 */
export const db = openDatabase()

function openDatabase(): DatabaseSync {
  mkdirSync(dirname(config.dbPath), { recursive: true })
  const database = new DatabaseSync(config.dbPath)
  database.exec(SCHEMA)
  ensureSingleUser(database)
  return database
}

/** Пока нет входа, вся работа идёт от имени одного пользователя. */
function ensureSingleUser(database: DatabaseSync): void {
  database
    .prepare('INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)')
    .run(config.singleUserId, 'локальный пользователь', new Date().toISOString())
}

export const nowIso = (): string => new Date().toISOString()

/** Короткий идентификатор: читаемый в логах и достаточно уникальный. */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
