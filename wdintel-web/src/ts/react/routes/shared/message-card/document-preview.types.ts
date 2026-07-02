export type MessageCardDocumentKind = 'pdf' | 'docx' | 'xlsx' | 'unsupported';

export type MessageCardDocument = {
  id?: string | null;
  href: string;
  fileName?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
  kind: MessageCardDocumentKind;
};

export type DocumentPreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export type DocumentPreviewEntryState<TLoaded = unknown> = {
  zoom: number;
  status: DocumentPreviewStatus;
  blob?: Blob;
  arrayBuffer?: ArrayBuffer;
  loaded?: TLoaded;
  error?: string;
};
