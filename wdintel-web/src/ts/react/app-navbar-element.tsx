import { useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppNavbar, type AppNavbarProps } from './components/app-navbar/AppNavbar';
import { clearBrowserDebugRecording } from '../debug-recorder';
import { NeoMuiThemeProvider } from './mui-theme';

type ParsedNavbarProps = Omit<
  AppNavbarProps,
  'onLogout' | 'onThemeChange' | 'onNavbarVisibilityChange' | 'onOpenChangelog'
>;

function AppNavbarRoot({
  parsedProps,
  host,
}: {
  parsedProps: ParsedNavbarProps | null;
  host: HTMLElement;
}) {
  const callbacks = useMemo(() => {
    return {
      onLogout: () => {
        clearBrowserDebugRecording();
        host.dispatchEvent(new CustomEvent('navbar-logout'));
      },
      onThemeChange: (theme: string) => {
        host.dispatchEvent(new CustomEvent('navbar-theme-toggle', { detail: theme }));
      },
      onNavbarVisibilityChange: () => {
        host.dispatchEvent(new CustomEvent('navbar-visibility-toggle'));
      },
      onOpenChangelog: (version: string) => {
        host.dispatchEvent(new CustomEvent('navbar-open-changelog', { detail: version }));
      },
    };
  }, [host]);

  if (!parsedProps) return null;

  return (
    <NeoMuiThemeProvider>
      <AppNavbar {...parsedProps} {...callbacks} />
    </NeoMuiThemeProvider>
  );
}

class AppNavbarElement extends HTMLElement {
  private root: Root | null = null;
  private _props: ParsedNavbarProps | null = null;

  set props(value: ParsedNavbarProps | null) {
    this._props = value;
    this.render();
  }

  get props() {
    return this._props;
  }

  private render() {
    if (!this.root) return;
    this.root.render(<AppNavbarRoot parsedProps={this._props} host={this} />);
  }

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
}

if (!customElements.get('app-navbar')) {
  customElements.define('app-navbar', AppNavbarElement);
}
