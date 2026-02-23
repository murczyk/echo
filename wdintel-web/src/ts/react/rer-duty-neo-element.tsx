import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useNeoMuiTheme } from './mui-theme';

import { RerDutyNeoPage } from './routes/rer-duty-neo';

/** Reads auth user name from layout (Elm sets data-auth-user-name on .app-shell for this page). */
function getAuthUserNameFromShell(el: Element): string | null {
  const shell = el.closest('.app-shell');
  const name = shell?.getAttribute('data-auth-user-name');
  return name != null && name !== '' ? name : null;
}

function RerDutyNeoRoot({ authUserName }: { authUserName: string | null }) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <RerDutyNeoPage authUserName={authUserName} />
    </ThemeProvider>
  );
}

class RerDutyNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }

    const authUserName = getAuthUserNameFromShell(this);
    this.root.render(<RerDutyNeoRoot authUserName={authUserName} />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-duty-neo')) {
  customElements.define('rer-duty-neo', RerDutyNeoElement);
}
