/**
 * Схема базы. Держим строкой в коде, а не отдельным .sql: тогда сборка не
 * обязана копировать ресурсы, и схема гарантированно совпадает с кодом.
 *
 * Многопользовательская с первого дня. Экрана входа пока нет и всё принадлежит
 * одному пользователю, но `user_id` уже стоит везде: дописать вход потом —
 * это добавить строки в users, а не переписывать каждый запрос и мигрировать
 * базу с данными.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  -- Хеш пароля, никогда не сам пароль. Пусто, пока входа нет.
  password    TEXT,
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  title         TEXT NOT NULL,
  project       TEXT NOT NULL,
  engine        TEXT NOT NULL,
  status        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- Проставлено — сессия в корзине. Удаление обратимо.
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id, deleted_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  model       TEXT,
  created_at  TEXT NOT NULL,
  -- Порядковый номер: created_at с точностью до секунды не различает
  -- сообщения, пришедшие в одну секунду.
  seq         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  engine       TEXT NOT NULL,
  status       TEXT NOT NULL,
  code         TEXT,
  result       TEXT,
  duration_ms  INTEGER,
  seq          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_msg   ON tool_calls(message_id, seq);

CREATE TABLE IF NOT EXISTS graphs (
  session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  doc         TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Снимок модели той сессии, в которой над ней работали.
--
-- Строка на сессию, а не история: нужен последний вид, а не архив. Без этой
-- таблицы снимок был один на всё приложение, и новый проект показывал модель
-- предыдущего — сессии отличались только перепиской.
-- Ключ составной: один проект бывает открыт сразу в SketchUp, Rhino и
-- Blender, и снимок у каждого свой. В дереве они станут тремя ветками.
CREATE TABLE IF NOT EXISTS snapshots (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  engine      TEXT NOT NULL,
  doc         TEXT NOT NULL,
  taken_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, engine)
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  spec         TEXT NOT NULL,
  status       TEXT NOT NULL,
  progress     REAL NOT NULL DEFAULT 0,
  message      TEXT,
  started_at   TEXT,
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_session     ON jobs(session_id);
`
