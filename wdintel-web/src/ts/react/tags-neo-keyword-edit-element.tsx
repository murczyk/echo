import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminTagsNeoKeywordEditPage } from './routes/admin-tags-neo-keyword-edit';
import { useNeoMuiTheme } from './mui-theme';

function TagsNeoKeywordEditRoot(props: { tagId: string | null; keywordId: string | null }) {
  const theme = useNeoMuiTheme();

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
