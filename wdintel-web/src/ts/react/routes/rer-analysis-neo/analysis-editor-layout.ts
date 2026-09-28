const ANALYSIS_LEFT_PANEL_WIDTH = 400;
const ANALYSIS_MIN_CENTER_WIDTH = 360;
const ANALYSIS_LEFT_PANEL_MIN_WIDTH = 1200;
const ANALYSIS_LEFT_PANEL_WITH_EDITOR_MIN_WIDTH = 1600;

type AnalysisLeftPanelLayoutInput = {
  layoutWidth: number | null;
  viewportWidth: number;
  desktop: boolean;
  leftPanelOpen: boolean;
  editorOpen: boolean;
};

export function shouldInlineAnalysisLeftPanel({
  layoutWidth,
  viewportWidth,
  desktop,
  leftPanelOpen,
  editorOpen,
}: AnalysisLeftPanelLayoutInput): boolean {
  if (!desktop || !leftPanelOpen || layoutWidth == null) return false;
  if (
    layoutWidth <
    (editorOpen ? ANALYSIS_LEFT_PANEL_WITH_EDITOR_MIN_WIDTH : ANALYSIS_LEFT_PANEL_MIN_WIDTH)
  ) {
    return false;
  }
  if (!editorOpen) return layoutWidth - ANALYSIS_LEFT_PANEL_WIDTH >= ANALYSIS_MIN_CENTER_WIDTH;

  const editorWidth = Math.min(640, Math.max(440, viewportWidth * 0.4));
  return layoutWidth - ANALYSIS_LEFT_PANEL_WIDTH - editorWidth >= ANALYSIS_MIN_CENTER_WIDTH;
}

export function analysisRightDockColumn(editorOpen: boolean): string {
  return editorOpen ? 'clamp(640px, 48%, 800px)' : 'minmax(0, 1fr)';
}

export function analysisWorkspaceColumns({
  inlineLeftPanelVisible,
  inlineRightDockVisible,
  editorOpen,
}: {
  inlineLeftPanelVisible: boolean;
  inlineRightDockVisible: boolean;
  editorOpen: boolean;
}): string {
  return [
    inlineLeftPanelVisible ? '400px' : '0px',
    'minmax(0, 1fr)',
    inlineRightDockVisible ? analysisRightDockColumn(editorOpen) : 'minmax(0, 0fr)',
  ].join(' ');
}
