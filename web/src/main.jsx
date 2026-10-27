import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted (CSP font-src 'self'); browsers fetch only the unicode ranges a page uses. CJK text falls back to system fonts.
import '@fontsource-variable/inter/index.css';
import './styles/index.css';
import './styles/responsive.css';
import './styles/finance.css';
import { App } from './App.jsx';
import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { boot } from './state/controller.js';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

boot();
