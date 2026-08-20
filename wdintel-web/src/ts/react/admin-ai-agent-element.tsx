import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AdminAiAgentPage, AiAgentAdminSection } from './routes/admin-ai-agent';

const SECTIONS = new Set<AiAgentAdminSection>([
  'providers',
  'containers',
  'requests',
  'dispatcher',
  'echo-proxies',
  'callsigns',
  'intelligence-reports',
  'ocr',
  'settings',
]);

function AdminAiAgentRoot({ section }: { section: AiAgentAdminSection }) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AdminAiAgentPage section={section} />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AdminAiAgentElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-section'];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
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
    const rawSection = this.getAttribute('data-section') as AiAgentAdminSection | null;
    const section = rawSection && SECTIONS.has(rawSection) ? rawSection : 'providers';
    this.root.render(<AdminAiAgentRoot section={section} />);
  }
}

if (!customElements.get('admin-ai-agent')) {
  customElements.define('admin-ai-agent', AdminAiAgentElement);
}
