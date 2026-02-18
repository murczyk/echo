import { createTheme, ThemeProvider } from '@mui/material/styles';
import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useNeoMuiTheme } from './mui-theme';

import { RerDutyNeoPage } from './routes/rer-duty-neo';

function RerDutyNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <RerDutyNeoPage />
    </ThemeProvider>
  );
}

class RerDutyNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<RerDutyNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('rer-duty-neo')) {
  customElements.define('rer-duty-neo', RerDutyNeoElement);
}
