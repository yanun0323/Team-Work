import { createRoot } from 'react-dom/client'
import { useSimLoop } from './core/store'
import { World } from './World'
import './fonts.css'
import './fusion.css'

function App() {
  // the fake runtime keeps the company files live
  useSimLoop()
  return <div className="fusion"><World /></div>
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
