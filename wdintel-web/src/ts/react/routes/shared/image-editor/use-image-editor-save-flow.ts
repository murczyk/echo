import { useCallback, type MutableRefObject } from 'react';

import { reconcileImageEditorAttachedArrows } from './image-editor-attached-arrow';
import { loadImageEditorFonts } from './image-editor-font';
import {
  exportEditedImage,
  imageEditorOutputExtension,
  imageEditorOutputMimeType,
} from './image-editor-export';
import { ImageEditorSaveDestination } from './image-editor.types';
import type { EditedImageResult, ImageEditorSource } from './image-editor.types';
import { useImageEditorSaveDialogState } from './use-image-editor-save-dialog-state';

export function useImageEditorSaveFlow({
  source,
  canvasRef,
  sourceRef,
  fabricRef,
  cropRef,
  applyingRef,
  applying,
  setApplying,
  isInteractionLocked,
  cancelInteractions,
  finalizeActiveText,
  flushScheduledHistory,
  flushRaster,
  onSaveReplacement,
  onSaveAsNew,
  setError,
}: {
  source: ImageEditorSource;
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  sourceRef: MutableRefObject<import('fabric').FabricImage | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
  applyingRef: MutableRefObject<boolean>;
  applying: boolean;
  setApplying: (value: boolean) => void;
  isInteractionLocked: () => boolean;
  cancelInteractions: () => void;
  finalizeActiveText: () => boolean;
  flushScheduledHistory: () => void;
  flushRaster: () => Promise<void>;
  onSaveReplacement: (result: EditedImageResult) => Promise<void> | void;
  onSaveAsNew: (result: EditedImageResult) => Promise<void> | void;
  setError: (error: string | null) => void;
}) {
  const outputExtension = imageEditorOutputExtension(imageEditorOutputMimeType(source));
  const saveDialogs = useImageEditorSaveDialogState({
    sourceFileName: source.fileName,
    outputExtension,
  });
  const save = useCallback(
    async (destination: ImageEditorSaveDestination, basename?: string) => {
      const canvas = canvasRef.current;
      const sourceImage = sourceRef.current;
      if (!canvas || !sourceImage || isInteractionLocked()) return;
      cancelInteractions();
      finalizeActiveText();
      if (cropRef.current) {
        setError('Спочатку застосуйте або скасуйте обрізання');
        return;
      }
      flushScheduledHistory();
      applyingRef.current = true;
      setApplying(true);
      saveDialogs.setSaveError(null);
      setError(null);
      try {
        await flushRaster();
        await loadImageEditorFonts();
        const fabric = fabricRef.current;
        if (fabric) reconcileImageEditorAttachedArrows({ canvas, fabric });
        const file = await exportEditedImage({
          canvas,
          source,
          sourceImage,
          outputBasename: basename,
        });
        if (destination === ImageEditorSaveDestination.Replacement)
          await onSaveReplacement({ file });
        else await onSaveAsNew({ file });
      } catch (cause) {
        saveDialogs.setSaveError(
          cause instanceof Error ? cause.message : 'Не вдалося зберегти зміни',
        );
        applyingRef.current = false;
        setApplying(false);
      }
    },
    [
      applyingRef,
      cancelInteractions,
      canvasRef,
      cropRef,
      fabricRef,
      finalizeActiveText,
      flushRaster,
      flushScheduledHistory,
      isInteractionLocked,
      onSaveAsNew,
      onSaveReplacement,
      saveDialogs,
      setError,
      source,
      sourceRef,
    ],
  );
  const submitSaveAsNew = useCallback(() => {
    const basename = saveDialogs.validatedBasename();
    if (!basename) {
      saveDialogs.setFilenameError('Вкажіть коректну назву файлу');
      return;
    }
    saveDialogs.setFilenameError(null);
    saveDialogs.setSaveError(null);
    void save(ImageEditorSaveDestination.New, basename);
  }, [save, saveDialogs]);
  return { outputExtension, save, saveDialogs, submitSaveAsNew };
}
