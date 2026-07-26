import { resolve } from 'node:path'

/**
 * Настройки берутся только из окружения. Значения по умолчанию рассчитаны на
 * локальный запуск; на виртуалке всё задаётся в /opt/complex/.env, который в
 * репозиторий не попадает.
 */
export const config = {
  /** Порт, на котором gateway слушает и HTTP, и веб-сокет. */
  port: Number(process.env.PORT ?? 8787),

  /** Файл базы. В контейнере это том, чтобы данные пережили пересборку. */
  dbPath: resolve(process.env.DB_PATH ?? './data/complex.db'),

  /**
   * Каталог собранного фронтенда. Тот же контейнер раздаёт и приложение, и API,
   * чтобы всё открывалось по одному адресу.
   */
  webRoot: process.env.WEB_ROOT ? resolve(process.env.WEB_ROOT) : null,

  /** Ключ OpenRouter. Пока пуст — чат отвечает заглушкой. */
  openRouterKey: process.env.OPENROUTER_API_KEY ?? '',

  /** Модель по умолчанию для живого чата. */
  defaultModel: process.env.DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5',

  /**
   * Пока нет входа, всё принадлежит одному пользователю. Схема базы при этом
   * многопользовательская с первого дня: добавить вход = добавить строки в
   * users и выдавать настоящий идентификатор, а не переписывать все запросы.
   */
  singleUserId: 'u-local',
} as const

export type Config = typeof config
