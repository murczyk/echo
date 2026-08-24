import { createRoot, Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { AdminReportDetailsPage } from './routes/admin-report-details';

function readReportId(element: Element): number | null {
  const raw = element.getAttribute('report-id')?.trim() ?? '';
  if (raw === '') return null;
  const reportId = Number.parseInt(raw, 10);
  return Number.isSafeInteger(reportId) && reportId > 0 ? reportId : null;
}

function AdminReportDetailsRoot({ reportId }: { reportId: number | null }) {
  return (
    <NeoMuiThemeProvider>
      {reportId === null ? (
        <div className="p-6 text-sm text-red-700">Некоректний ID звіту.</div>
      ) : (
        <AdminReportDetailsPage reportId={reportId} />
      )}
    </NeoMuiThemeProvider>
  );
}

class AdminReportDetailsElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return ['report-id'];
  }

  private renderRoot() {
    this.root?.render(<AdminReportDetailsRoot reportId={readReportId(this)} />);
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'block';
      this.style.width = '100%';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (name === 'report-id' && oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }
}

if (!customElements.get('admin-report-details')) {
  customElements.define('admin-report-details', AdminReportDetailsElement);
}
