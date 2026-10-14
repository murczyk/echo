export const DUTY_MIN_EDITOR_FEED_WIDTH = 360;
export const DUTY_MULTI_FEED_GAP = 16;
export const DUTY_EDITOR_TRACK = 'clamp(640px, 48%, 800px)';

export function dutyEditorLayoutColumns(editorEmbeddedOpen: boolean): string {
  return editorEmbeddedOpen
    ? `minmax(0, 1fr) ${DUTY_EDITOR_TRACK}`
    : 'minmax(0, 1fr) minmax(0, 0fr)';
}

type DutyEditorLayoutInput = {
  narrowScreen: boolean;
  editorEmbeddedOpen: boolean;
  availableWidth: number | null;
  feedCount: number;
};

export function shouldUseActiveFeedLayout({
  narrowScreen,
  editorEmbeddedOpen,
  availableWidth,
  feedCount,
}: DutyEditorLayoutInput): boolean {
  if (narrowScreen) return true;
  if (!editorEmbeddedOpen || feedCount <= 1) return false;
  if (availableWidth == null) return false;

  const requiredWidth =
    feedCount * DUTY_MIN_EDITOR_FEED_WIDTH + Math.max(0, feedCount - 1) * DUTY_MULTI_FEED_GAP;
  return availableWidth < requiredWidth;
}
