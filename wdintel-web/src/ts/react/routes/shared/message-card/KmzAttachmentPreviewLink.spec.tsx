/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KmzAttachmentPreviewLink } from './KmzAttachmentPreviewLink';

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getPreview: vi.fn(),
}));

vi.mock('../../../services/api/kmz-attachment-conversion', () => ({
  getKmzAttachmentConversionStatus: api.getStatus,
  getKmzAttachmentPreview: api.getPreview,
  kmzAttachmentConversionDownloadUrl: (mediaId: string) =>
    `/api/messenger/media/${mediaId}/kmz-conversion/download`,
}));

vi.mock('./KmzAttachmentPreviewMap', () => ({
  KmzAttachmentPreviewMap: () => <div data-testid="converted-kmz-preview" />,
}));

let root: Root | null = null;

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  );
}

function findLink(label: string): HTMLAnchorElement | undefined {
  return Array.from(document.body.querySelectorAll('a')).find(
    (link) => link.textContent?.trim() === label,
  );
}

beforeEach(() => {
  api.getStatus.mockResolvedValue({
    status: 'done',
    error: null,
    convertedFileName: 'route_converted.kmz',
  });
  api.getPreview.mockResolvedValue({
    points: [],
    lineStrings: [
      {
        coords: [
          { lat: 50.45, lng: 30.52 },
          { lat: 50.46, lng: 30.53 },
        ],
        color: '#123456',
      },
    ],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('KmzAttachmentPreviewLink', () => {
  it('opens the converted preview with both downloads above it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <KmzAttachmentPreviewLink
          mediaId="media-1"
          originalHref="/api/messenger/media/media-1"
          fileName="route.gpx"
          initialStatus="pending"
        />,
      );
    });

    await act(async () => {
      findButton('route.gpx')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(api.getStatus).toHaveBeenCalledWith(
      'media-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(api.getPreview).toHaveBeenCalledWith(
      'media-1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const original = findLink('Завантажити оригінал');
    const converted = findLink('Завантажити конвертований KMZ');
    const preview = document.body.querySelector('[data-testid="converted-kmz-preview"]');
    expect(original?.getAttribute('href')).toBe('/api/messenger/media/media-1');
    expect(original?.getAttribute('download')).toBe('route.gpx');
    expect(converted?.getAttribute('href')).toBe(
      '/api/messenger/media/media-1/kmz-conversion/download',
    );
    expect(converted?.getAttribute('download')).toBe('route_converted.kmz');
    expect(preview).not.toBeNull();
    expect(
      (original?.compareDocumentPosition(preview as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
