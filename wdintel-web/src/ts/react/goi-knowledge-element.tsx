import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { GoiKnowledgePage } from './routes/goi-knowledge';

function GoiKnowledgeRoot() {
  return (
    <NeoMuiThemeProvider>
      <GoiKnowledgePage />
    </NeoMuiThemeProvider>
  );
}

class GoiKnowledgeElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<GoiKnowledgeRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('goi-knowledge')) {
  customElements.define('goi-knowledge', GoiKnowledgeElement);
}
