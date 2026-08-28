import type { MessageCardImage } from '../message-card/message-card-image-utils';

export type ImageEditorEscapeHandler = (event: globalThis.KeyboardEvent) => boolean;
export type RegisterImageEditorEscapeHandler = (handler: ImageEditorEscapeHandler | null) => void;

export enum ImageEditorTool {
  Select = 'select',
  Pan = 'pan',
  Crop = 'crop',
  Text = 'text',
  Rectangle = 'rectangle',
  Ellipse = 'ellipse',
  Line = 'line',
  Arrow = 'arrow',
  Brush = 'brush',
  Highlight = 'highlight',
  Conceal = 'conceal',
  Magnifier = 'magnifier',
}

export enum ImageEditorSelectionKind {
  Text = 'text',
  Shape = 'shape',
  Line = 'line',
  Brush = 'brush',
  Highlight = 'highlight',
  Concealment = 'concealment',
}

export enum ImageEditorObjectRole {
  Source = 'source',
  Text = 'text',
  Rectangle = 'rectangle',
  Ellipse = 'ellipse',
  Line = 'line',
  Arrow = 'arrow',
  Brush = 'brush',
  Highlight = 'highlight',
  ConcealmentDraft = 'concealment-draft',
  Concealment = 'concealment',
  Crop = 'crop',
  CropMask = 'crop-mask',
}

export enum ConcealMode {
  Blur = 'blur',
  Pixelate = 'pixelate',
  Redact = 'redact',
}

export enum ImageEditorSaveDialog {
  Replacement = 'replacement',
  New = 'new',
}
export enum ImageEditorSaveDestination {
  Replacement = 'replacement',
  New = 'new',
}

export type ImageEditorSelectionDescriptor = {
  kind: ImageEditorSelectionKind;
  role: ImageEditorObjectRole;
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
