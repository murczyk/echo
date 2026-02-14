import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminTagsNeoEditPage } from './routes/admin-tags-neo-edit';
import { useNeoMuiTheme } from './mui-theme';

function TagsNeoEditRoot(props: { tagId: string | null }) {
  const theme = useNeoMuiTheme();

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
