import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AdminOrganismsNeoEditPage } from './routes/admin-organisms-neo-edit';

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

function OrganismsNeoEditRoot(props: { organismId: string | null }) {
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <AdminOrganismsNeoEditPage organismId={props.organismId} />
    </ThemeProvider>
  );
}

class OrganismsNeoEditElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-organism-id'];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private render() {
    if (!this.root) return;
    const organismId = this.getAttribute('data-organism-id');
    this.root.render(<OrganismsNeoEditRoot organismId={organismId} />);
  }
}

if (!customElements.get('organisms-neo-edit')) {
  customElements.define('organisms-neo-edit', OrganismsNeoEditElement);
}
