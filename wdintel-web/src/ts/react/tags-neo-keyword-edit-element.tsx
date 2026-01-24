import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';

import { AdminTagsNeoKeywordEditPage } from './routes/admin-tags-neo-keyword-edit';

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

function TagsNeoKeywordEditRoot(props: { tagId: string | null; keywordId: string | null }) {
  const mode = useMuiPaletteMode();
  const theme = React.useMemo(() => createTheme({ palette: { mode } }), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <AdminTagsNeoKeywordEditPage tagId={props.tagId} keywordId={props.keywordId} />
    </ThemeProvider>
  );
}

class TagsNeoKeywordEditElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-tag-id', 'data-keyword-id'];
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
    const keywordId = this.getAttribute('data-keyword-id');
    this.root.render(<TagsNeoKeywordEditRoot tagId={tagId} keywordId={keywordId} />);
  }
}

if (!customElements.get('tags-neo-keyword-edit')) {
  customElements.define('tags-neo-keyword-edit', TagsNeoKeywordEditElement);
}
