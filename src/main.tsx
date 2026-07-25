import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyTheme, resolveTheme } from './lib/theme.ts'

// Resolve before the first React paint so the stored choice never flashes past
// the prefers-color-scheme fallback that index.css uses until data-theme exists.
applyTheme(resolveTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
