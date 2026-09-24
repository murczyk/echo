import { ThemeProvider } from '@mui/material/styles';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { AuthorLabel } from './components/AuthorLabel';
import { PowerSnackbarProvider, usePowerSnackbar } from './components/PowerSnackbar';
import { AUTHOR_IDENTITIES_ERROR_EVENT } from './author-identities';
import { useNeoMuiTheme } from './mui-theme';

function AuthorLabelRoot(props: Parameters<typeof AuthorLabel>[0]) {
  const theme = useNeoMuiTheme();
  return (
    <ThemeProvider theme={theme}>
      <AuthorLabel {...props} />
    </ThemeProvider>
  );
}

class AuthorLabelElement extends HTMLElement {
  private root: Root | null = null;
  static get observedAttributes() {
    return ['login', 'account-id', 'fallback'];
  }
  connectedCallback() {
    this.root ??= createRoot(this);
    this.renderRoot();
  }
  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
  attributeChangedCallback() {
    this.renderRoot();
  }
  private renderRoot() {
    this.root?.render(
      <AuthorLabelRoot
        login={this.getAttribute('login')}
        accountId={this.getAttribute('account-id')}
        fallback={this.getAttribute('fallback')}
      />,
    );
  }
}

function ErrorListener() {
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    const onError = (event: Event) =>
      notify({ severity: 'error', message: (event as CustomEvent<string>).detail });
    window.addEventListener(AUTHOR_IDENTITIES_ERROR_EVENT, onError);
    return () => window.removeEventListener(AUTHOR_IDENTITIES_ERROR_EVENT, onError);
  }, [notify]);
  return null;
}

function Notifications() {
  const theme = useNeoMuiTheme();
  return (
    <ThemeProvider theme={theme}>
      <PowerSnackbarProvider>
        <ErrorListener />
      </PowerSnackbarProvider>
    </ThemeProvider>
  );
}

if (!customElements.get('echo-author-label')) {
  customElements.define('echo-author-label', AuthorLabelElement);
}

let notificationsMounted = false;
export function initializeAuthorNotifications() {
  if (notificationsMounted) return;
  notificationsMounted = true;
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(<Notifications />);
}
