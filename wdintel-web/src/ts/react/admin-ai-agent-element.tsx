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
  'settlements',
  'positions',
  'position',
  'intelligence-reports',
  'ocr',
  'documents',
  'settings',
]);

function AdminAiAgentRoot({
  section,
  itemId,
  tab,
}: {
  section: AiAgentAdminSection;
  itemId: string | null;
  tab: string | null;
}) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AdminAiAgentPage section={section} itemId={itemId} tab={tab} />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AdminAiAgentElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['data-section', 'data-item-id', 'data-tab'];
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
    this.root.render(
      <AdminAiAgentRoot
        section={section}
        itemId={this.getAttribute('data-item-id')}
        tab={this.getAttribute('data-tab')}
      />,
    );
  }
}

if (!customElements.get('admin-ai-agent')) {
  customElements.define('admin-ai-agent', AdminAiAgentElement);
}
