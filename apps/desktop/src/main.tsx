import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CaptionOverlay } from '@/components/sabir/caption-overlay'
import { LiveIndicator } from '@/components/sabir/live-indicator'

const view = new URLSearchParams(window.location.search).get('view')

if (view === 'float') document.body.classList.add('lt-float')
if (view === 'caption') document.body.classList.add('lt-caption')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {view === 'float' ? (
      <LiveIndicator />
    ) : view === 'caption' ? (
      <CaptionOverlay />
    ) : (
      <App />
    )}
  </StrictMode>,
)
