import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
// Abstract ABA brand colour tokens (shared with the tenant web app).
import '../../../packages/design-tokens/brand.css';
import './styles/global.css';
import './styles/redesign.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
