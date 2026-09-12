import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react';

import { imageEditorToolFromKeyboardEvent } from './image-editor-shortcuts';
import { ImageEditorTool } from './image-editor.types';
import type { RegisterImageEditorEscapeHandler } from './image-editor.types';
import type { useImageEditorSaveDialogState } from './use-image-editor-save-dialog-state';

let activeImageEditor: symbol | null = null;

type KeyboardState = {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
  cancelInteractions: () => boolean;
  loading: boolean;
  applying: boolean;
  rasterPending: boolean;
  saveDialogs: ReturnType<typeof useImageEditorSaveDialogState>;
  confirmCancel: boolean;
  menuOpen: boolean;
  setConfirmCancel: (value: boolean) => void;
  setMenuOpen: (value: boolean) => void;
  dismissMenu: () => void;
  finalizeActiveText: () => boolean;
  activeTextIsEditing: () => boolean;
  cancelCrop: () => void;
  requestCancel: () => void;
  isInteractionLocked: () => boolean;
  changeTool: (tool: ImageEditorTool) => void;
  tool: ImageEditorTool;
  applyCrop: () => void;
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
};

export function useImageEditorKeyboardShortcuts({
  editorIdRef,
  editorRootRef,
  registerEscapeHandler,
  ...state
}: KeyboardState & {
  editorIdRef: MutableRefObject<symbol>;
  editorRootRef: MutableRefObject<HTMLElement | null>;
  registerEscapeHandler?: RegisterImageEditorEscapeHandler;
}) {
  const stateRef = useRef(state);
  stateRef.current = state;
  const handleEscape = useCallback((event: KeyboardEvent) => {
    const current = stateRef.current;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-image-editor-local-escape]'))
      return false;
    if (current.loading || current.applying || current.rasterPending) return true;
    if (current.saveDialogs.activeDialog) {
      current.saveDialogs.closeDialog(current.saveDialogs.activeDialog);
      return true;
    }
    if (current.confirmCancel) {
      current.setConfirmCancel(false);
      return true;
    }
    if (current.menuOpen) {
      current.setMenuOpen(false);
      current.dismissMenu();
      return true;
    }
    if (current.activeTextIsEditing()) {
      current.finalizeActiveText();
      return true;
    }
    if (current.cropRef.current) {
      current.cancelCrop();
      return true;
    }
    if (current.cancelInteractions()) return true;
    current.requestCancel();
    return true;
  }, []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const root =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-image-editor-root]')
          : null;
      if (root ? root !== editorRootRef.current : activeImageEditor !== editorIdRef.current) return;
      if (event.key === 'Escape' && !registerEscapeHandler && handleEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const current = stateRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const nativeControl = Boolean(
        target?.closest(
          'button, input, textarea, select, option, [contenteditable="true"], [role="slider"]',
        ),
      );
      const typing =
        event.isComposing ||
        nativeControl ||
        (current.canvasRef.current?.getActiveObject() as import('fabric').IText | undefined)
          ?.isEditing === true;
      if (
        typing ||
        current.isInteractionLocked() ||
        current.saveDialogs.activeDialog ||
        current.confirmCancel ||
        current.menuOpen
      )
        return;
      const shortcutTool = imageEditorToolFromKeyboardEvent(event);
      if (shortcutTool) {
        event.preventDefault();
        event.stopPropagation();
        current.changeTool(shortcutTool);
        return;
      }
      if (
        event.key === 'Enter' &&
        current.tool === ImageEditorTool.Crop &&
        current.cropRef.current
      ) {
        event.preventDefault();
        current.applyCrop();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? current.redo() : current.undo();
      }
      if (event.key === 'y' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        current.redo();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        current.deleteSelected();
      }
    },
    [editorIdRef, editorRootRef, handleEscape, registerEscapeHandler],
  );
  useEffect(() => {
    activeImageEditor = editorIdRef.current;
    return () => {
      if (activeImageEditor === editorIdRef.current) activeImageEditor = null;
    };
  }, [editorIdRef]);
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onKeyDown]);
  useLayoutEffect(() => {
    if (!registerEscapeHandler) return;
    registerEscapeHandler(handleEscape);
    return () => registerEscapeHandler(null);
  }, [handleEscape, registerEscapeHandler]);
  const activate = useCallback(() => {
    activeImageEditor = editorIdRef.current;
  }, [editorIdRef]);
  return { activate };
}
