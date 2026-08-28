export enum EditorViewMode {
  Fit = 'fit',
  Actual = 'actual',
  Custom = 'custom',
}

export type EditorViewState = {
  scale: number;
  pan: { x: number; y: number };
  mode: EditorViewMode;
};

export type EditorSize = { width: number; height: number };

export const IMAGE_EDITOR_WORKSPACE_INSET = 24;
export const MIN_EDITOR_SCALE = 0.1;
export const MAX_EDITOR_SCALE = 8;

export function fitEditorScale(document: EditorSize, workspace: EditorSize) {
  const availableWidth = Math.max(1, workspace.width - IMAGE_EDITOR_WORKSPACE_INSET * 2);
  const availableHeight = Math.max(1, workspace.height - IMAGE_EDITOR_WORKSPACE_INSET * 2);
  return Math.min(1, availableWidth / document.width, availableHeight / document.height);
}

export function clampEditorScale(scale: number) {
  return Math.max(MIN_EDITOR_SCALE, Math.min(MAX_EDITOR_SCALE, scale));
}

export function centerEditorView(view: EditorViewState): EditorViewState {
  return { ...view, pan: { x: 0, y: 0 } };
}

export function resizeEditorView(
  view: EditorViewState,
  document: EditorSize,
  workspace: EditorSize,
): EditorViewState {
  if (view.mode === EditorViewMode.Fit)
    return {
      scale: fitEditorScale(document, workspace),
      pan: { x: 0, y: 0 },
      mode: EditorViewMode.Fit,
    };
  return { ...view, pan: clampEditorPan(view.pan, document, workspace, view.scale) };
}

export function clampEditorPan(
  pan: EditorViewState['pan'],
  document: EditorSize,
  workspace: EditorSize,
  scale: number,
) {
  const limitX = Math.max(
    0,
    (document.width * scale + workspace.width) / 2 - IMAGE_EDITOR_WORKSPACE_INSET,
  );
  const limitY = Math.max(
    0,
    (document.height * scale + workspace.height) / 2 - IMAGE_EDITOR_WORKSPACE_INSET,
  );
  return {
    x: Math.max(-limitX, Math.min(limitX, pan.x)),
    y: Math.max(-limitY, Math.min(limitY, pan.y)),
  };
}

export function zoomEditorAtPoint({
  view,
  document,
  workspace,
  point,
  scale,
}: {
  view: EditorViewState;
  document: EditorSize;
  workspace: EditorSize;
  point: { x: number; y: number };
  scale: number;
}): EditorViewState {
  const nextScale = clampEditorScale(scale);
  const offset = { x: point.x - workspace.width / 2, y: point.y - workspace.height / 2 };
  const ratio = nextScale / view.scale;
  return {
    scale: nextScale,
    pan: clampEditorPan(
      {
        x: view.pan.x * ratio + offset.x * (1 - ratio),
        y: view.pan.y * ratio + offset.y * (1 - ratio),
      },
      document,
      workspace,
      nextScale,
    ),
    mode: EditorViewMode.Custom,
  };
}
