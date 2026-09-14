/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Palitra } from '../../../../../Bindings';
import { createPalitraPageActionHandlers } from '../use-rer-palitra-neo-page.palitra-actions';

const palitraApiMock = vi.hoisted(() => ({
  analyzePalitraKmz: vi.fn(),
  archivePalitra: vi.fn(),
  createPalitraBasicWithKmz: vi.fn(),
  createPalitraWithKmz: vi.fn(),
  deletePalitra: vi.fn(),
  downloadPalitras: vi.fn(),
  retryGoiSourceConversion: vi.fn(),
  retryPalitraConversion: vi.fn(),
  unarchivePalitra: vi.fn(),
  updatePalitra: vi.fn(),
  uploadPalitraPoints: vi.fn(),
}));
const downloadBlobMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/api/palitra', () => palitraApiMock);
vi.mock('../../../utils/download-blob', () => ({ downloadBlob: downloadBlobMock }));

function makePalitra(id: number): Palitra {
  return {
    id,
    name: 'Palitra ' + String(id),
    folder: null,
    isArchived: false,
    colorHex: '#00bcd4',
    author: 'operator',
    sourceFileName: null,
    lastUploadedAtTs: null,
    accessLogins: [],
    accessOrganismIds: [],
    accessAorId: [],
  } as Palitra;
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    downloadDialogPalitra: makePalitra(42),
    downloadSplitForDelta: true,
    folderActionsBlocked: false,
    inFlightDownloadId: null,
    setDownloadDialogOpen: vi.fn(),
    setInFlightDownloadId: vi.fn(),
    setStatus: vi.fn(),
    ...overrides,
  } as Parameters<typeof createPalitraPageActionHandlers>[0];
}

describe('rer palitra actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to default download when Delta split has no geometry', async () => {
    const blob = new Blob(['zip']);
    palitraApiMock.downloadPalitras
      .mockRejectedValueOnce(new Error('Palitra has no geometry to split for Delta: palitra_id=42'))
      .mockResolvedValueOnce(blob);

    const props = makeProps();
    const handlers = createPalitraPageActionHandlers(props);

    await handlers.confirmDownload();

    expect(palitraApiMock.downloadPalitras).toHaveBeenNthCalledWith(1, [42], {
      splitForDelta: true,
    });
    expect(palitraApiMock.downloadPalitras).toHaveBeenNthCalledWith(2, [42]);
    expect(downloadBlobMock).toHaveBeenCalledWith(blob, 'palitra-42.zip');
    expect(props.setDownloadDialogOpen).toHaveBeenCalledWith(false);
    expect(props.setStatus).toHaveBeenCalledTimes(1);
    expect(props.setStatus).toHaveBeenCalledWith(null);
  });

  it('keeps other Delta split errors visible', async () => {
    palitraApiMock.downloadPalitras.mockRejectedValueOnce(new Error('Delta split failed'));

    const props = makeProps();
    const handlers = createPalitraPageActionHandlers(props);

    await handlers.confirmDownload();

    expect(palitraApiMock.downloadPalitras).toHaveBeenCalledTimes(1);
    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(props.setStatus).toHaveBeenLastCalledWith({
      kind: 'error',
      text: 'Не вдалося завантажити палітру: Delta split failed',
    });
  });
});
