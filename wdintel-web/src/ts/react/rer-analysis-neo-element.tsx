import { isNullOrUndefined } from './utils/misc';


import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { RerAnalysisNeoPage } from './routes/rer-analysis-neo';

function getAuthUserNameFromShell(el: Element): string | null {
  const shell = el.closest('.app-shell');
  const name = shell?.getAttribute('data-auth-user-name');
  if (isNullOrUndefined(name) || name === '' || name === 'anonymous') return null;
  return name;
}

function RerAnalysisNeoRoot({ authUserName }: { authUserName: string | null }) {
  return (
    <NeoMuiThemeProvider>
      <RerAnalysisNeoPage authUserName={authUserName} />
    </NeoMuiThemeProvider>
  );
}

class RerAnalysisNeoElement extends HTMLElement {
  private root: Root | null = null;
  private observer: MutationObserver | null = null;

  private renderRoot() {
    if (!this.root) return;
    this.root.render(<RerAnalysisNeoRoot authUserName={getAuthUserNameFromShell(this)} />);
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }

    this.renderRoot();

    const shell = this.closest('.app-shell');
    if (shell && !this.observer) {
      this.observer = new MutationObserver(() => this.renderRoot());
      this.observer.observe(shell, { attributes: true, attributeFilter: ['data-auth-user-name'] });
    }
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.observer = null;
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-analysis-neo')) {
  customElements.define('rer-analysis-neo', RerAnalysisNeoElement);
}
