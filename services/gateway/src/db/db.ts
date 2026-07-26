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
  migrate(database)
  database.exec(SCHEMA)
  ensureSingleUser(database)
  return database
}

/**
 * Правки схемы для баз, созданных прежними версиями.
 *
 * `CREATE TABLE IF NOT EXISTS` существующую таблицу не меняет — старая база
 * молча остаётся со старыми столбцами, и запрос падает уже в работе. Поймано
 * ровно так: «no such column: engine» на живом сервере после выкладки.
 */
function migrate(database: DatabaseSync): void {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshots'")
    .all() as Array<{ name: string }>
  if (!tables.length) return

  const columns = database.prepare('PRAGMA table_info(snapshots)').all() as Array<{ name: string }>
  if (columns.some((c) => c.name === 'engine')) return

  // Снимок — производное от модели в движке: он перечитывается кнопкой за
  // секунду. Переносить его в новую форму дороже, чем забрать заново, поэтому
  // таблицу пересоздаём. Переписка, графы и сессии при этом не трогаются.
  database.exec('DROP TABLE snapshots')
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
