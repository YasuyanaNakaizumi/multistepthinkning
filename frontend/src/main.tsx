import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { LocaleProvider } from './i18n'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
)
