import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import { LiteApp } from './LiteApp';
import './styles.css';

class LiteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: '' };

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error || '未知错误');
    return { failed: true, message: message.slice(0, 180) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Sully Lite] render error', error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="lite-crash-screen">
          <section>
            <h1>页面没有丢失</h1>
            <p>Lite 遇到了一次显示兼容问题，已阻止它变成空白页。</p>
            {this.state.message && <code>{this.state.message}</code>}
            <button type="button" onClick={() => window.location.reload()}>重新载入</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('lite-root')!).render(
  <React.StrictMode>
    <LiteErrorBoundary><LiteApp /></LiteErrorBoundary>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
