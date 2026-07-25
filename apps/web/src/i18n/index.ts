import { en } from './en'
import { ru, type I18nKey } from './ru'

export type Locale = 'ru' | 'en'

const dictionaries: Record<Locale, Record<I18nKey, string>> = { ru, en }

/** Основной язык. Переключатель локали — задача этапа продукта. */
let locale: Locale = 'ru'

export function setLocale(next: Locale): void {
  locale = next
}

export function getLocale(): Locale {
  return locale
}

/** Строки UI берём только отсюда — хардкод текста в JSX запрещён. */
export function t(key: I18nKey): string {
  return dictionaries[locale][key]
}

export type { I18nKey }
