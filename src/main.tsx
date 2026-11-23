import { createRoot } from 'react-dom/client'
import { configuredClient } from './data'
import { App } from './auth'
import './style.css'

const db = configuredClient()
createRoot(document.getElementById('root')!).render(db ? <App db={db} /> : (
  <main className="access"><p className="eyebrow">Planning IDEL · 2027</p><h1>Configuration manquante</h1><p>Le service de connexion n’est pas configuré.</p></main>
))
