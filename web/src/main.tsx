import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Weight and width axes: words stay at normal width, live numbers are set condensed.
import '@fontsource-variable/bricolage-grotesque/wdth.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
