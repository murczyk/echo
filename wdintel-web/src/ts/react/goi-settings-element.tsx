import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { GoiSettingsPage } from './routes/goi-settings';

function GoiSettingsRoot() {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <GoiSettingsPage />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class GoiSettingsElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private renderRoot() {
    if (!this.root) return;
    this.root.render(<GoiSettingsRoot />);
  }
}

if (!customElements.get('goi-settings')) {
  customElements.define('goi-settings', GoiSettingsElement);
}
