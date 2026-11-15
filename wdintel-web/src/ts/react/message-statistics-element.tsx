import { createRoot, type Root } from 'react-dom/client';
import { NeoMuiThemeProvider } from './mui-theme';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { PowerAlert } from './components/PowerAlert';
import { hasRerOrCyber } from './utils/roles';
import { MessageStatisticsPage } from './routes/message-statistics';

class MessageStatisticsElement extends HTMLElement {
  private root: Root | null = null;
  private observer: MutationObserver | null = null;
  private renderPage() {
    const roles = this.getAttribute('data-auth-user-roles')?.split(',') ?? [];
    this.root?.render(
      <NeoMuiThemeProvider>
        <PowerSnackbarProvider>
          {hasRerOrCyber(roles) ? (
            <MessageStatisticsPage
              key={`${this.getAttribute('data-auth-user-id') ?? ''}:${roles.join(',')}`}
            />
          ) : (
            <PowerAlert severity="error">Немає доступу до статистики повідомлень.</PowerAlert>
          )}
        </PowerSnackbarProvider>
      </NeoMuiThemeProvider>,
    );
  }
  connectedCallback() {
    this.root = createRoot(this);
    this.renderPage();
    const shell = this;
    if (shell) {
      this.observer = new MutationObserver(() => this.renderPage());
      this.observer.observe(shell, {
        attributes: true,
        attributeFilter: ['data-auth-user-id', 'data-auth-user-roles'],
      });
    }
  }
  disconnectedCallback() {
    this.observer?.disconnect();
    this.root?.unmount();
    this.root = null;
  }
}
if (!customElements.get('message-statistics'))
  customElements.define('message-statistics', MessageStatisticsElement);
