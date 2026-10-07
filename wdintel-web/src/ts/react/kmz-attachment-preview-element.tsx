import { createRoot, type Root } from 'react-dom/client';

import { NeoMuiThemeProvider } from './mui-theme';
import { PowerSnackbarProvider } from './components/PowerSnackbar';
import { KmzAttachmentPreviewLink } from './routes/shared/message-card/KmzAttachmentPreviewLink';
import { useMessageCardDownloadGuard } from './routes/shared/message-card/MessageCardMedia';

function KmzAttachmentPreviewElementContent({
  mediaId,
  originalHref,
  fileName,
  initialStatus,
  sizeBytes,
  contentType,
}: {
  mediaId: string;
  originalHref: string;
  fileName: string;
  initialStatus: string;
  sizeBytes: number | null;
  contentType: string | null;
}) {
  const downloadGuard = useMessageCardDownloadGuard();

  return (
    <KmzAttachmentPreviewLink
      mediaId={mediaId}
      originalHref={originalHref}
      fileName={fileName}
      initialStatus={initialStatus}
      sizeBytes={sizeBytes}
      contentType={contentType}
      isDownloadStarting={downloadGuard.isDownloadStarting}
      onDownloadStart={downloadGuard.onDownloadStart}
    />
  );
}

class KmzAttachmentPreviewElement extends HTMLElement {
  private root: Root | null = null;

  static get observedAttributes() {
    return [
      'media-id',
      'original-href',
      'file-name',
      'size-bytes',
      'content-type',
      'conversion-status',
    ];
  }

  connectedCallback() {
    if (!this.root) {
      this.style.display = 'inline-block';
      this.style.maxWidth = '100%';
      this.root = createRoot(this);
    }
    this.renderRoot();
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue !== newValue) this.renderRoot();
  }

  disconnectedCallback() {
    this.root?.unmount();
    this.root = null;
  }

  private renderRoot() {
    if (!this.root) return;
    const mediaId = this.getAttribute('media-id')?.trim() ?? '';
    if (!mediaId) {
      this.root.render(null);
      return;
    }
    this.root.render(
      <NeoMuiThemeProvider>
        <PowerSnackbarProvider>
          <KmzAttachmentPreviewElementContent
            mediaId={mediaId}
            originalHref={this.getAttribute('original-href') ?? ''}
            fileName={this.getAttribute('file-name') || '<файл без назви>'}
            initialStatus={this.getAttribute('conversion-status') ?? 'pending'}
            sizeBytes={Number(this.getAttribute('size-bytes')) || null}
            contentType={this.getAttribute('content-type') || null}
          />
        </PowerSnackbarProvider>
      </NeoMuiThemeProvider>,
    );
  }
}

if (!customElements.get('kmz-attachment-preview')) {
  customElements.define('kmz-attachment-preview', KmzAttachmentPreviewElement);
}
