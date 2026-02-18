import { ThemeProvider } from '@mui/material/styles';
import { createRoot, Root } from 'react-dom/client';

import { AdminAorNeoFormPage } from './routes/admin-aor-neo-form';
import { useNeoMuiTheme } from './mui-theme';

function AorNeoFormRoot(props: { aorId: string | null }) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <AdminAorNeoFormPage aorId={props.aorId} />
    </ThemeProvider>
  );
}

class AorNeoFormElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-aor-id'];
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
    const aorId = this.getAttribute('data-aor-id');
    this.root.render(<AorNeoFormRoot aorId={aorId} />);
  }
}

if (!customElements.get('aor-neo-form')) {
  customElements.define('aor-neo-form', AorNeoFormElement);
}
