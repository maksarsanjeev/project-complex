import { useState } from 'react'
import { useChat } from '../store/chat'
import { Label, cx } from '../ui'
import s from './checkpoint.module.css'

/**
 * Карточка чекпойнта: проход закончен, слово за человеком.
 *
 * Почему на треть экрана, а не строкой кнопок под вводом. Раньше модель,
 * оставленная одна, полировала бесконечно — за один заход двадцать четыре
 * круга доводки, о которых никто не просил. Теперь она останавливается, но
 * остановка бесполезна, если её не заметить: решается здесь не мелочь, а
 * тратить ли ещё миллион токенов. Поэтому карточка перекрывает вьюпорт и
 * требует ответа.
 *
 * Третий вариант — «скажу своими словами» — не кнопка, а поле: чаще всего
 * человек хочет не «продолжай», а «переделай вот эту деталь».
 *
 * Заголовок намеренно нейтральный. Сначала здесь стояло «итерация завершена»,
 * и карточка соврала на первом же живом случае: модель не построила ничего, а
 * спрашивала про упавший мост. Под этой карточкой бывает любая остановка,
 * требующая человека, — текст внутри и объясняет, какая именно.
 */
export function Checkpoint() {
  const checkpoint = useChat((c) => c.checkpoint)
  const send = useChat((c) => c.send)
  const setDraft = useChat((c) => c.setDraft)
  const [own, setOwn] = useState('')

  if (!checkpoint) return null

  // Ответ уходит обычным сообщением: чекпойнт — это пауза в разговоре, а не
  // отдельный канал. Модель продолжит ровно с того места, где встала.
  const answer = (text: string): void => {
    if (!text.trim()) return
    setOwn('')
    setDraft(text)
    void send()
  }

  // Последний вариант отдаём полю ввода: он и означает «своими словами».
  const buttons = checkpoint.options.slice(0, 2)

  return (
    <div className={s.veil}>
      <section className={s.card}>
        <header className={s.head}>
          <Label>Требуется решение</Label>
          <span className={s.hint}>работа приостановлена</span>
        </header>

        {/* Длинные отчёты — норма: модель перечисляет десятки деталей. Текст
            прокручивается внутри, кнопки остаются на месте. */}
        <div className={s.body}>{checkpoint.question}</div>

        <div className={s.actions}>
          {buttons.map((option, index) => (
            <button
              key={option}
              type="button"
              className={cx(s.button, index === 0 && s['button--primary'])}
              onClick={() => answer(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <div className={s.own}>
          <input
            className={s.input}
            value={own}
            placeholder="или скажите своими словами — что поправить"
            onChange={(e) => setOwn(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') answer(own)
            }}
          />
          <button type="button" className={s.button} disabled={!own.trim()} onClick={() => answer(own)}>
            отправить
          </button>
        </div>
      </section>
    </div>
  )
}
