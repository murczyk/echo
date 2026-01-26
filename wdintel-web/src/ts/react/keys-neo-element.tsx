import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AdminKeysNeoPage } from './routes/admin-keys-neo';

function getMuiPaletteMode(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'dark' : 'light';
}

function useMuiPaletteMode() {
  const [mode, setMode] = React.useState(getMuiPaletteMode);

  React.useEffect(() => {
    const observer = new MutationObserver(() => setMode(getMuiPaletteMode()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-bs-theme'],
    });

    return () => observer.disconnect();
  }, []);

  return mode;
}

function KeysNeoRoot() {
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <AdminKeysNeoPage />
    </ThemeProvider>
  );
}

class KeysNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<KeysNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('keys-neo')) {
  customElements.define('keys-neo', KeysNeoElement);
}
