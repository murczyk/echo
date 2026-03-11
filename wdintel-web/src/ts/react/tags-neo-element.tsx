import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminTagsNeoPage } from './routes/admin-tags-neo';
import { useNeoMuiTheme } from './mui-theme';

function TagsNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminTagsNeoPage />
    </ThemeProvider>
  );
}

class TagsNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.root.render(<TagsNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('tags-neo')) {
  customElements.define('tags-neo', TagsNeoElement);
}
