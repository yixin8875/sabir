import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LiveIndicator } from '@/components/livetrans/live-indicator'

const floatView =
  new URLSearchParams(window.location.search).get('view') === 'float'

if (floatView) document.body.classList.add('lt-float')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {floatView ? <LiveIndicator /> : <App />}
  </StrictMode>,
)
