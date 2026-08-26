import { ImageEditorToolRail } from './ImageEditorToolRail';
import type { ReactNode } from 'react';
import type { ImageEditorTool } from './image-editor.types';

export type ImageEditorToolbarProps = {
  disabled: boolean;
  tool: ImageEditorTool;
  onToolChange: (tool: ImageEditorTool) => void;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  canDeleteSelected: boolean;
  onDeleteSelected: () => void;
  onZoomChange: (next: number) => void;
  onFitViewport: () => void;
  onActualSize: () => void;
  onCenterViewport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetEdits: () => void;
  contextualControls?: ReactNode;
};

export function ImageEditorToolbar(props: ImageEditorToolbarProps) {
  return <ImageEditorToolRail {...props} />;
}
