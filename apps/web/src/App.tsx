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

  return <Shell />
}
