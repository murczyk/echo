import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminBattleLinePage } from './routes/admin-battle-line';

class AdminBattleLineElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) this.root = createRoot(this);
    this.root.render(
      <NeoMuiThemeProvider>
        <AdminBattleLinePage />
      </NeoMuiThemeProvider>,
    );
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-battle-line')) {
  customElements.define('admin-battle-line', AdminBattleLineElement);
}
