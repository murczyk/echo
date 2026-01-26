import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AdminControlPanelNeoPage } from './routes/admin-control-panel-neo';

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

function ControlPanelNeoRoot() {
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <AdminControlPanelNeoPage />
    </ThemeProvider>
  );
}

class ControlPanelNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<ControlPanelNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('control-panel-neo')) {
  customElements.define('control-panel-neo', ControlPanelNeoElement);
}
