import type { MessageCardImage } from '../message-card/message-card-image-utils';

export type ImageEditorEscapeHandler = (event: globalThis.KeyboardEvent) => boolean;
export type RegisterImageEditorEscapeHandler = (handler: ImageEditorEscapeHandler | null) => void;

export type ImageEditorTool =
  | 'select'
  | 'pan'
  | 'crop'
  | 'text'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'brush'
  | 'highlight'
  | 'conceal'
  | 'magnifier';

export type ConcealMode = 'blur' | 'pixelate' | 'redact';

export type ImageEditorSelectionDescriptor = {
  kind: 'text' | 'shape' | 'line' | 'brush' | 'highlight' | 'concealment';
  role: string;
};

export type ImageEditorSource = {
  blob: Blob;
  fileName: string;
  mimeType: string;
};

export type EditedImageResult = {
  file: File;
};

export type ImageEditingCapability = {
  canEdit: (image: MessageCardImage) => boolean;
  loadSource: (image: MessageCardImage, signal: AbortSignal) => Promise<ImageEditorSource>;
  applyReplacement: (image: MessageCardImage, result: EditedImageResult) => Promise<void> | void;
  addAsNew: (image: MessageCardImage, result: EditedImageResult) => Promise<void> | void;
};
