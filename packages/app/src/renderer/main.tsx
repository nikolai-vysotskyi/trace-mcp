import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Gallery } from './lattice/ui/Gallery';

// `?view=gallery` renders the control-primitive reference surface instead of
// the app (TRA-290). Routed here, not inside App, so it needs none of the app's
// daemon state — it is just the stylesheet plus the primitives.
const params = new URLSearchParams(window.location.search);
const isGallery = params.get('view') === 'gallery';
// `&theme=light|dark` pins the appearance so both can be screenshotted; the app
// itself gets its theme from useTheme, which the gallery route bypasses.
const forcedTheme = params.get('theme');
if (isGallery && (forcedTheme === 'light' || forcedTheme === 'dark')) {
  document.documentElement.dataset.theme = forcedTheme;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="App">{isGallery ? <Gallery /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
