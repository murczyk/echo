import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { GoiSettingsPage } from './routes/goi-settings';

type GoiSettingsRootProps = {
  goiHost: string | null;
};

function GoiSettingsRoot(props: GoiSettingsRootProps) {
  return (
    <NeoMuiThemeProvider>
      <GoiSettingsPage goiHost={props.goiHost} />
    </NeoMuiThemeProvider>
  );
}

class GoiSettingsElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-goi-host'];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.renderRoot();
  }

  attributeChangedCallback() {
    this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private renderRoot() {
    if (!this.root) return;

    const rawHost = this.getAttribute('data-goi-host');
    const goiHost = rawHost && rawHost.trim().length > 0 ? rawHost.trim() : null;
    this.root.render(<GoiSettingsRoot goiHost={goiHost} />);
  }
}

if (!customElements.get('goi-settings')) {
  customElements.define('goi-settings', GoiSettingsElement);
}
