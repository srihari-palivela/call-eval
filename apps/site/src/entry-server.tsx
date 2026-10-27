// Prerender: the page's HTML at build time, so the text paints before any JavaScript runs.
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App } from './App';

export { SITE } from './site';

export function render(): string {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
