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
    if (object.type === 'i-text')
      assignImageEditorTextareaContainer(object as import('fabric').IText, container);
  });
}
