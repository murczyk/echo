import { createRoot, Root } from 'react-dom/client';

import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { NeoMuiThemeProvider } from './mui-theme';
import { AiAgentChat, type AiAgentAvailabilityState } from './routes/ai-agent-chat';

function AiAgentChatRoot({
  onAvailabilityChange,
}: {
  onAvailabilityChange: (state: AiAgentAvailabilityState) => void;
}) {
  return (
    <NeoMuiThemeProvider>
      <PowerSnackbarProvider>
        <AiAgentChat onAvailabilityChange={onAvailabilityChange} />
      </PowerSnackbarProvider>
    </NeoMuiThemeProvider>
  );
}

class AiAgentChatElement extends HTMLElement {
  private root: Root | null = null;

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

  private render() {
    this.root?.render(<AiAgentChatRoot onAvailabilityChange={this.handleAvailabilityChange} />);
  }
}

if (!customElements.get('ai-agent-chat')) {
  customElements.define('ai-agent-chat', AiAgentChatElement);
}
