import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { t } from './i18n';
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

// Startup metric of record for the perf harness (docs/perf/README.md). The
// browser's own `first-contentful-paint` only exists for a frame the compositor
// presented, and every agent run drives this app with the window unmapped so it
// never steals the user's screen — so that entry is always absent there. This
// mark is the same event one step earlier: React has committed the first
// content under #root, on the renderer's own clock, with no compositor and no
// CDP round-trip involved. Installed before render because React commits
// asynchronously — there is no point after this call that is reliably "after
// the first commit".
const rootEl = document.getElementById('root')!;
const firstContent = new MutationObserver(() => {
  if (!rootEl.firstElementChild) return;
  performance.mark('app-first-content');
  firstContent.disconnect();
});
firstContent.observe(rootEl, { childList: true });

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary label={t('shell:app')}>{isGallery ? <Gallery /> : <App />}</ErrorBoundary>
  </StrictMode>,
);
