import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { GoiAssociationsPage } from './routes/goi-associations';

function GoiAssociationsRoot() {
  return (
    <NeoMuiThemeProvider>
      <GoiAssociationsPage />
    </NeoMuiThemeProvider>
  );
}

class GoiAssociationsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<GoiAssociationsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('goi-associations')) {
  customElements.define('goi-associations', GoiAssociationsElement);
}
