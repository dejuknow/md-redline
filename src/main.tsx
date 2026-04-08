import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from 'next-themes';
import { SettingsProvider } from './contexts/SettingsContext';
import { ThemePersistenceProvider } from './contexts/ThemePersistenceContext';
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
      <ThemePersistenceProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </ThemePersistenceProvider>
    </ThemeProvider>
  </StrictMode>,
);
