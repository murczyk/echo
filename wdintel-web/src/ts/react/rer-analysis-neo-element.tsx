import { isNullOrUndefined } from './utils/misc';

import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { POWER_ANALYSIS_SNACKBAR_CLEARANCE } from './routes/shared/manage-message/floating-control-geometry';
import { RerAnalysisNeoPage } from './routes/rer-analysis-neo';

function getAuthUserNameFromShell(el: Element): string | null {
  const shell = el.closest('.app-shell');
  const name = shell?.getAttribute('data-auth-user-name');
  if (isNullOrUndefined(name) || name === '' || name === 'anonymous') return null;
  return name;
}

function getAuthUserRolesFromShell(el: Element): string[] {
  const raw =
    el.getAttribute('data-auth-user-roles') ??
    el.closest('.app-shell')?.getAttribute('data-auth-user-roles') ??
    '';
  return raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}

function RerAnalysisNeoRoot({
  authUserName,
  authUserRoles,
}: {
  authUserName: string | null;
  authUserRoles: string[];
}) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider bottomInset={POWER_ANALYSIS_SNACKBAR_CLEARANCE}>
        <RerAnalysisNeoPage
          key={`${authUserName ?? ''}:${authUserRoles.join(',')}`}
          authUserName={authUserName}
          authUserRoles={authUserRoles}
        />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class RerAnalysisNeoElement extends HTMLElement {
  private root: Root | null = null;
  private observer: MutationObserver | null = null;

  static get observedAttributes() {
    return ['data-auth-user-roles'];
  }

  private renderRoot() {
    if (!this.root) return;
    this.root.render(
      <RerAnalysisNeoRoot
        authUserName={getAuthUserNameFromShell(this)}
        authUserRoles={getAuthUserRolesFromShell(this)}
      />,
    );
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
      this.observer.observe(shell, {
        attributes: true,
        attributeFilter: ['data-auth-user-name', 'data-auth-user-roles'],
      });
    }
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === 'data-auth-user-roles' && oldValue !== newValue) {
      this.renderRoot();
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
