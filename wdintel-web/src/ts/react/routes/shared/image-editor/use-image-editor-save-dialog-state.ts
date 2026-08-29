import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { imageEditorOutputBasename } from './image-editor-export';
import { ImageEditorSaveDialog } from './image-editor.types';

type ActiveImageEditorSaveDialog = ImageEditorSaveDialog | null;

export function useImageEditorSaveDialogState({
  sourceFileName,
  outputExtension,
}: {
  sourceFileName: string;
  outputExtension: string;
}) {
  const [activeDialog, setActiveDialog] = useState<ActiveImageEditorSaveDialog>(null);
  const [basename, setBasenameValue] = useState(() => imageEditorOutputBasename(sourceFileName));
  const [filenameError, setFilenameError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pendingFocusRef = useRef<RefObject<HTMLButtonElement | null> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearErrors = useCallback(() => {
    setFilenameError(null);
    setSaveError(null);
  }, []);
  const openDialog = useCallback(
    (dialog: ImageEditorSaveDialog, buttonRef: RefObject<HTMLButtonElement | null>) => {
      pendingFocusRef.current = buttonRef;
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
      clearErrors();
      if (dialog === ImageEditorSaveDialog.New)
        setBasenameValue(imageEditorOutputBasename(sourceFileName));
      requestAnimationFrame(() => {
        if (mountedRef.current) setActiveDialog(dialog);
      });
    },
    [clearErrors, sourceFileName],
  );
  const closeDialog = useCallback(
    (dialog: ImageEditorSaveDialog) => {
      setActiveDialog((active) => (active === dialog ? null : active));
      clearErrors();
    },
    [clearErrors],
  );
  const restoreFocusAfterExit = useCallback(() => {
    const buttonRef = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (mountedRef.current) buttonRef?.current?.focus();
  }, []);
  const setBasename = useCallback(
    (value: string) => {
      setBasenameValue(value);
      clearErrors();
    },
    [clearErrors],
  );
  const validatedBasename = useCallback(() => {
    const extension = `.${outputExtension}`;
    const trimmed = basename.trim();
    const value = trimmed.toLowerCase().endsWith(extension.toLowerCase())
      ? trimmed.slice(0, -extension.length).trim()
      : trimmed;
    if (!value || value === '.' || value === '..') return null;
    if (/[\\/\0\p{Cc}]/u.test(value)) return null;
    return value;
  }, [basename, outputExtension]);

  return {
    activeDialog,
    basename,
    clearErrors,
    closeDialog,
    filenameError,
    openDialog,
    restoreFocusAfterExit,
    saveError,
    setBasename,
    setFilenameError,
    setSaveError,
    validatedBasename,
  };
}
