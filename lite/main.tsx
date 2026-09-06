import React from 'react';
import ReactDOM from 'react-dom/client';
import { LiteApp } from './LiteApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('lite-root')!).render(
  <React.StrictMode>
    <LiteApp />
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
