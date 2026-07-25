import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Шрифты кладём локально из npm — без CDN и без сетевых зависимостей.
// index.css обоих пакетов содержит кириллические подмножества.
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'

import './styles/tokens.css'
import './styles/base.css'

import App from './App'

const container = document.getElementById('root')
if (!container) throw new Error('корневой элемент #root не найден')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
