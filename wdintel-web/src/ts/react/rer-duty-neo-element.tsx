import { ThemeProvider } from '@mui/material/styles';

import { createRoot, Root } from 'react-dom/client';
import { useNeoMuiTheme } from './mui-theme';

import { RerDutyNeoPage } from './routes/rer-duty-neo';

/** Reads auth user name from layout (Elm sets data-auth-user-name on .app-shell for this page). Treat "anonymous" as no user. */
function getAuthUserNameFromShell(el: Element): string | null {
  const shell = el.closest('.app-shell');
  const name = shell?.getAttribute('data-auth-user-name');
  if (name == null || name === '' || name === 'anonymous') return null;
  return name;
}

function RerDutyNeoRoot({ authUserName }: { authUserName: string | null }) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <RerDutyNeoPage authUserName={authUserName} />
    </ThemeProvider>
  );
}

const AUTH_USER_NAME_ATTR = 'data-auth-user-name';

class RerDutyNeoElement extends HTMLElement {
  private root: Root | null = null;
  private observer: MutationObserver | null = null;

  private renderRoot() {
    if (!this.root) return;
    const authUserName = getAuthUserNameFromShell(this);
    this.root.render(<RerDutyNeoRoot authUserName={authUserName} />);
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'flex';
      this.style.flexDirection = 'column';
      this.style.flex = '1 1 0%';
      this.style.minHeight = '0';
      this.style.minWidth = '0';
      this.style.width = '100%';
      this.style.touchAction = 'manipulation';
      this.root = createRoot(this);
    }

    this.renderRoot();

    const shell = this.closest('.app-shell');
    if (shell && !this.observer) {
      this.observer = new MutationObserver(() => this.renderRoot());
      this.observer.observe(shell, { attributes: true, attributeFilter: [AUTH_USER_NAME_ATTR] });
    }
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.observer = null;
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-duty-neo')) {
  customElements.define('rer-duty-neo', RerDutyNeoElement);
}
