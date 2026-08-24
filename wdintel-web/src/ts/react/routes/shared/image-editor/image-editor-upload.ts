import type { Uppy, UppyFile } from '@uppy/core';

type PendingImageFile = Pick<UppyFile<any, any>, 'meta'>;

export function replacePendingImageFile({
  uppy,
  fileId,
  pending,
  replacement,
}: {
  uppy: Pick<Uppy, 'setFileState'>;
  fileId: string;
  pending: PendingImageFile;
  replacement: File;
}) {
  const extension = replacement.name.split('.').pop() ?? '';
  uppy.setFileState(fileId, {
    data: replacement,
    name: replacement.name,
    type: replacement.type,
    size: replacement.size,
    extension,
    meta: {
      ...pending.meta,
      name: replacement.name,
      type: replacement.type,
      filename: replacement.name,
      fileName: replacement.name,
      file_type: replacement.type,
      fileType: replacement.type,
      extension,
    },
    error: null,
    progress: {
      percentage: 0,
      bytesTotal: replacement.size,
      bytesUploaded: 0,
      uploadComplete: false,
      uploadStarted: null,
    } as unknown as UppyFile<any, any>['progress'],
  });
}
