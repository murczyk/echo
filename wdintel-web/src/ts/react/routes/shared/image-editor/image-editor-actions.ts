type FabricModule = typeof import('fabric');

import { assignImageEditorTextareaContainer } from './image-editor-text';
import { createPaddedTextAnnotation } from './image-editor-padded-text';
import { ImageEditorObjectRole } from './image-editor.types';

export function addTextAnnotation({
  canvas,
  fabric,
  stroke,
  fontSize,
  bold,
  backgroundColor = '#000000',
  backgroundEnabled = false,
  backgroundPadding = 6,
  left,
  top,
  hiddenTextareaContainer,
}: {
  canvas: import('fabric').Canvas;
  fabric: FabricModule;
  stroke: string;
  fontSize: number;
  bold: boolean;
  backgroundColor?: string;
  backgroundEnabled?: boolean;
  backgroundPadding?: number;
  left: number;
  top: number;
  hiddenTextareaContainer: HTMLElement | null;
}) {
  const text = createPaddedTextAnnotation({
    fabric,
    text: '',
    options: {
      left,
      top,
      originX: 'left',
      originY: 'top',
      fill: stroke,
      fontSize,
      fontWeight: bold ? 'bold' : 'normal',
      editorRole: ImageEditorObjectRole.Text,
      annotationBackgroundColor: backgroundColor,
      annotationBackgroundEnabled: backgroundEnabled,
      annotationBackgroundPadding: backgroundPadding,
    },
  });
  assignImageEditorTextareaContainer(text, hiddenTextareaContainer);
  canvas.add(text);
  return text;
}

export function deleteSelectedAnnotations(canvas: import('fabric').Canvas) {
  const selected = canvas
    .getActiveObjects()
    .filter(
      (object) =>
        ![
          ImageEditorObjectRole.Concealment,
          ImageEditorObjectRole.Crop,
          ImageEditorObjectRole.CropMask,
        ].includes(object.get('editorRole')),
    );
  selected.forEach((object) => canvas.remove(object));
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}
