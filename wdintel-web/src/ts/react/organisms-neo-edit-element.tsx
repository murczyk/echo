import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminOrganismsNeoEditPage } from './routes/admin-organisms-neo-edit';
import { useNeoMuiTheme } from './mui-theme';

function OrganismsNeoEditRoot(props: { organismId: string | null }) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminOrganismsNeoEditPage organismId={props.organismId} />
    </ThemeProvider>
  );
}

class OrganismsNeoEditElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-organism-id'];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.root = createRoot(this);
    }

    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private render() {
    if (!this.root) return;
    const organismId = this.getAttribute('data-organism-id');
    this.root.render(<OrganismsNeoEditRoot organismId={organismId} />);
  }
}

if (!customElements.get('organisms-neo-edit')) {
  customElements.define('organisms-neo-edit', OrganismsNeoEditElement);
}
