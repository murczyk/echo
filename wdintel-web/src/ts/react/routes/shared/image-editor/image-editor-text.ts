import { IMAGE_EDITOR_TEXT_TYPE } from './image-editor-padded-text';

function isImageEditorTextAnnotation(object: import('fabric').FabricObject) {
  return object.type === 'i-text' || object.type === IMAGE_EDITOR_TEXT_TYPE;
}

export function assignImageEditorTextareaContainer(
  text: import('fabric').IText,
  container: HTMLElement | null,
) {
  text.hiddenTextareaContainer = container;
  return text;
}

export function assignImageEditorTextareaContainers(
  canvas: import('fabric').Canvas,
  container: HTMLElement | null,
) {
  canvas.getObjects().forEach((object) => {
    if (isImageEditorTextAnnotation(object))
      assignImageEditorTextareaContainer(object as import('fabric').IText, container);
  });
}
