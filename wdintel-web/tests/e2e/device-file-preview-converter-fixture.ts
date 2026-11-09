import { syncPreviewFile, uploadPreviewContent } from './device-file-preview-backend';
import { loadDeviceFilePreviewFixture } from './device-file-preview.fixtures';
import type { FilePreviewBackend } from './device-file-preview.ui';

export async function createConverterTransportFixture(backend: FilePreviewBackend) {
  const { fixture } = await loadDeviceFilePreviewFixture('converted-map-gpx');
  const source = await backend.login('source');
  // Transport tests control the converter response; these opaque bytes are not a TRK parser fixture.
  const bytes = Buffer.from('Opaque converter transport regression fixture #3930\n');
  const file = await syncPreviewFile(source, backend.fixtures.deviceId!, {
    ...fixture,
    id: 'converter-transport',
    fileName: 'converter-transport-only.trk',
    extension: 'trk',
    mimeType: 'application/octet-stream',
  });
  const receipt = await uploadPreviewContent(source, backend.fixtures.deviceId!, file, bytes);
  return { file, bytes, ...receipt };
}
