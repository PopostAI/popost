import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootEditor } from './app/boot';
import './styles/editor.css';
import { App } from './ui/App';

const { controller, lang, baseHref } = bootEditor();
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App controller={controller} lang={lang} baseHref={baseHref} />
  </StrictMode>,
);
