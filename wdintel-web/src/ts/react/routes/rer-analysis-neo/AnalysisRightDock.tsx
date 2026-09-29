import { useEffect, useState, type ReactNode } from 'react';

import {
  MANAGE_MESSAGE_EDITOR_TRANSITION_MS,
  type ManageMessageEditorPresentation,
} from '../shared/manage-message/ManageMessageEditorSurface';

type Props = {
  presentation: ManageMessageEditorPresentation;
  editorOpen: boolean;
  analyticsOpen: boolean;
  editor: ReactNode;
  analytics: ReactNode;
};

export function AnalysisRightDock({
  presentation,
  editorOpen,
  analyticsOpen,
  editor,
  analytics,
}: Props) {
  const [editorMounted, setEditorMounted] = useState(editorOpen);

  useEffect(() => {
    if (editorOpen) {
      setEditorMounted(true);
      return;
    }
    if (analyticsOpen) {
      setEditorMounted(false);
      return;
    }
    const timeoutId = window.setTimeout(
      () => setEditorMounted(false),
      MANAGE_MESSAGE_EDITOR_TRANSITION_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [analyticsOpen, editorOpen]);
  const editorVisible = editorOpen || editorMounted;

  return (
    <aside
      data-testid="analysis-right-dock"
      aria-label="Права панель аналізу"
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        display:
          presentation === 'modal' ? 'contents' : editorVisible || analyticsOpen ? 'flex' : 'none',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {editorVisible ? (
        <div
          data-analysis-dock-panel="editor"
          style={{
            flex: 1,
            width: '100%',
            height: presentation === 'embedded' ? '100%' : undefined,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            display: presentation === 'embedded' ? 'flex' : 'contents',
            flexDirection: 'column',
          }}
        >
          {editor}
        </div>
      ) : analyticsOpen ? (
        <div
          data-analysis-dock-panel="analytics"
          style={{
            flex: 1,
            width: '100%',
            height: presentation === 'embedded' ? '100%' : undefined,
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            display: presentation === 'embedded' ? 'flex' : 'contents',
            flexDirection: 'column',
          }}
        >
          {analytics}
        </div>
      ) : null}
    </aside>
  );
}
