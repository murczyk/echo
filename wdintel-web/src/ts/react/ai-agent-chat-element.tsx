import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import {
  AiAgentChat,
  AiAgentChatInitialLoading,
  type AiAgentAvailabilityState,
} from './routes/ai-agent-chat';

function AiAgentChatRoot({
  onAvailabilityChange,
  loading,
}: {
  onAvailabilityChange: (state: AiAgentAvailabilityState) => void;
  loading: boolean;
}) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        {loading ? (
          <AiAgentChatInitialLoading />
        ) : (
          <AiAgentChat onAvailabilityChange={onAvailabilityChange} />
        )}
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AiAgentChatElement extends HTMLElement {
  private root: Root | null = null;

  static observedAttributes = ['data-loading'];

  private readonly handleAvailabilityChange = (state: AiAgentAvailabilityState) => {
    this.dispatchEvent(
      new CustomEvent('ai-agent-availability', {
        bubbles: true,
        detail: { state, enabled: state === 'enabled' },
      }),
    );
  };

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.render();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  attributeChangedCallback() {
    this.render();
  }

  private render() {
    this.root?.render(
      <AiAgentChatRoot
        loading={this.getAttribute('data-loading') === 'true'}
        onAvailabilityChange={this.handleAvailabilityChange}
      />,
    );
  }
}

if (!customElements.get('ai-agent-chat')) {
  customElements.define('ai-agent-chat', AiAgentChatElement);
}
