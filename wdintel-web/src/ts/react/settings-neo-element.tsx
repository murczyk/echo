import { ThemeProvider } from "@mui/material/styles";
import { createRoot, Root } from "react-dom/client";

import { SettingsNeoPage, type SettingsSection } from "./routes/settings-neo";
import { useNeoMuiTheme } from "./mui-theme";

type SettingsNeoRootProps = {
  section: SettingsSection;
};

function SettingsNeoRoot({ section }: SettingsNeoRootProps) {
  const theme = useNeoMuiTheme();

  return (
    <ThemeProvider theme={theme}>
      <SettingsNeoPage section={section} />
    </ThemeProvider>
  );
}

class SettingsNeoElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ["data-settings-section"];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = "block";
      this.style.width = "100%";
      this.style.height = "100%";
      this.root = createRoot(this);
    }

    this.renderRoot();
  }

  attributeChangedCallback() {
    this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private renderRoot() {
    if (!this.root) return;
    const section = (this.getAttribute("data-settings-section") ?? "general") as SettingsSection;
    this.root.render(<SettingsNeoRoot section={section} />);
  }
}

if (!customElements.get("settings-neo")) {
  customElements.define("settings-neo", SettingsNeoElement);
}
