import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminOrganismsNeoPage } from './routes/admin-organisms-neo';
import { useNeoMuiTheme } from './mui-theme';

function OrganismsNeoRoot() {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminOrganismsNeoPage />
    </ThemeProvider>
  );
}

class OrganismsNeoElement extends HTMLElement {
  private root: Root | null = null;

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.root = createRoot(this);
    }
    this.root.render(<OrganismsNeoRoot />);
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('organisms-neo')) {
  customElements.define('organisms-neo', OrganismsNeoElement);
}
