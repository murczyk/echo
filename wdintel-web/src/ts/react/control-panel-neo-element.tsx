import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminControlPanelNeoPage } from './routes/admin-control-panel-neo';
import { useNeoMuiTheme } from './mui-theme';

function ControlPanelNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminControlPanelNeoPage />
    </ThemeProvider>
  );
}

class ControlPanelNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.root.render(<ControlPanelNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('control-panel-neo')) {
  customElements.define('control-panel-neo', ControlPanelNeoElement);
}
