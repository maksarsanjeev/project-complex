import { useEffect } from 'react'
import { Shell } from './layout/Shell'
import { applyTheme, useLayout } from './store/layout'
import { useEngines } from './store/engine'
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

  return <Shell />
}
