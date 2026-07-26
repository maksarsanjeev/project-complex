import { useEffect } from 'react'
import { Shell } from './layout/Shell'
import { applyTheme, useLayout } from './store/layout'
import { transport } from './api/transport'
import { useEngines } from './store/engine'
import { useModel } from './store/model'
import { useViewport } from './store/viewport'
import { useSession } from './store/session'

export default function App() {
  const theme = useLayout((l) => l.theme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    void useSession.getState().init()
    void useEngines.getState().load()
  }, [])

  // Состояние движков теперь живое: агент докладывает, что запущено на рабочей
  // машине. Запрашивать его один раз при загрузке мало — пользователь откроет
  // SketchUp уже после, и панель осталась бы врать до перезагрузки страницы.
  //
  // Пять секунд — шаг опроса самого агента, чаще спрашивать нечего. Пока
  // вкладка не на виду, не спрашиваем вовсе: смотреть на панель всё равно
  // некому, а свежее состояние подтянется при возвращении.
  useEffect(() => {
    const refresh = (): void => {
      if (!document.hidden) void useEngines.getState().load()
    }
    const timer = setInterval(refresh, 5000)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  // Выделение, сделанное в веб-морде, отражаем в самом движке — чтобы человек
  // видел на экране приложения ровно то, о чём говорит в чате. Подписка, а не
  // вызов из каждого места клика: выделяют из вьюпорта, из аутлайнера и
  // мышью с Ctrl, и все три пути должны вести к одному действию.
  useEffect(() => {
    let last = ''
    return useViewport.subscribe((state) => {
      // Отражать нечего, пока модель не забрана: узлы движку неизвестны.
      if (!useModel.getState().snapshot) return
      const key = state.selected.join(',')
      if (key === last) return
      last = key
      void transport.setSelection(state.selected).catch(() => {})
    })
  }, [])

  return <Shell />
}
