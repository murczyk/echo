import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AdminTagsNeoEditPage } from './routes/admin-tags-neo-edit';

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

function TagsNeoEditRoot(props: { tagId: string | null }) {
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <AdminTagsNeoEditPage tagId={props.tagId} />
    </ThemeProvider>
  );
}

class TagsNeoEditElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-tag-id'];
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
    const tagId = this.getAttribute('data-tag-id');
    this.root.render(<TagsNeoEditRoot tagId={tagId} />);
  }
}

if (!customElements.get('tags-neo-edit')) {
  customElements.define('tags-neo-edit', TagsNeoEditElement);
}
