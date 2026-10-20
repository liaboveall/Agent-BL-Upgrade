import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import './styles/responsive.css';
import './styles/finance.css';
import { App } from './App.jsx';
import { boot } from './state/controller.js';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);

boot();
