import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { MyReportsPage } from './routes/my-reports';

function MyReportsRoot() {
  return (
    <NeoMuiThemeProvider>
      <MyReportsPage />
    </NeoMuiThemeProvider>
  );
}

class MyReportsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.minHeight = '0';
      this.root = createRoot(this);
    }
    this.root.render(<MyReportsRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('my-reports')) {
  customElements.define('my-reports', MyReportsElement);
}
