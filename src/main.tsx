import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="light"
      themes={['light', 'dark', 'sepia', 'nord']}
      enableSystem={false}
    >
      <App />
    </ThemeProvider>
  </StrictMode>,
);
