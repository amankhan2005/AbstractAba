import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
// Abstract ABA brand colour tokens (shared with the platform console).
import '../../../packages/design-tokens/brand.css';
import './styles/global.css';
// Feature styles added after the design system; must load AFTER global.css so
// they can use its custom properties.
import './styles/index.css';
// Premium redesign layer (Module RX) — shells, dashboards, primitives. Loads
// last so it can build on the locked design tokens from the earlier sheets.
import './styles/redesign.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
