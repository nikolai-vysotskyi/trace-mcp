import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="App">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
