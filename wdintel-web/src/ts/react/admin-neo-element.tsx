import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AdminNeoPage } from './routes/admin-neo';

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

function AdminNeoRoot() {
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <AdminNeoPage />
    </ThemeProvider>
  );
}

class AdminNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<AdminNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-neo')) {
  customElements.define('admin-neo', AdminNeoElement);
}
