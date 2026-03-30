import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import { SettingsProvider } from './contexts/SettingsContext';
import { ALL_THEMES } from './lib/themes';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="system"
      themes={ALL_THEMES.map((t) => t.key)}
      enableSystem={true}
    >
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ThemeProvider>
  </StrictMode>,
);
