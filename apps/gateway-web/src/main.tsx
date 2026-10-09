import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import './gateway.css'
import './DirectWorkstepWorkspace.css'
import './NotificationCenter.css'
import './AdminPermissionsPage.css'
import './projectInvitations.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>,
)
