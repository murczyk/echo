import { useCallback, useEffect, useRef, useState } from 'react';

import type { MessageCardImage } from '../message-card-image-utils';
import type {
  EditedImageResult,
  ImageEditingCapability,
  ImageEditorSource,
  RegisterImageEditorEscapeHandler,
} from '../../image-editor/image-editor.types';

type EditorSession = { target: MessageCardImage; targetKey: string; source: ImageEditorSource };

function imageTargetKey(image: MessageCardImage) {
  return image.id?.trim() || image.href || image.fileName || '';
}

export function useImageAttachmentEditorSession({
  image,
  imageEditing,
  registerEditorEscapeHandler,
}: {
  image: MessageCardImage;
  imageEditing?: ImageEditingCapability;
  registerEditorEscapeHandler?: RegisterImageEditorEscapeHandler;
}) {
  const [session, setSession] = useState<EditorSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentKeyRef = useRef(imageTargetKey(image));
  const requestRef = useRef<{
    generation: number;
    targetKey: string;
    controller: AbortController;
  } | null>(null);
  const generationRef = useRef(0);
  currentKeyRef.current = imageTargetKey(image);

  const clearRequest = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    setLoading(false);
    registerEditorEscapeHandler?.(null);
  }, [registerEditorEscapeHandler]);

  const close = useCallback(() => {
    clearRequest();
    setSession(null);
  }, [clearRequest]);

  const open = useCallback(async () => {
    if (!imageEditing || loading || session || !imageEditing.canEdit(image)) return;
    clearRequest();
    const target = image;
    const targetKey = imageTargetKey(target);
    const request = {
      generation: ++generationRef.current,
      targetKey,
      controller: new AbortController(),
    };
    requestRef.current = request;
    let established = false;
    setError(null);
    setLoading(true);
    registerEditorEscapeHandler?.(() => true);
    try {
      const source = await imageEditing.loadSource(target, request.controller.signal);
      if (
        request.controller.signal.aborted ||
        requestRef.current !== request ||
        generationRef.current !== request.generation ||
        currentKeyRef.current !== targetKey
      )
        return;
      setSession({ target, targetKey, source });
      established = true;
    } catch (cause) {
      if (!request.controller.signal.aborted && requestRef.current === request)
        setError(cause instanceof Error ? cause.message : 'Не вдалося завантажити зображення');
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setLoading(false);
        if (!established) registerEditorEscapeHandler?.(null);
      }
    }
  }, [clearRequest, image, imageEditing, loading, registerEditorEscapeHandler, session]);

  const apply = useCallback(
    async (result: EditedImageResult) => {
      if (!session || !imageEditing) return;
      await imageEditing.applyReplacement(session.target, result);
      close();
    },
    [close, imageEditing, session],
  );

  useEffect(() => {
    const request = requestRef.current;
    if (request && request.targetKey !== currentKeyRef.current) clearRequest();
  }, [clearRequest, image]);
  useEffect(() => () => clearRequest(), [clearRequest]);

  return { apply, close, error, isLocked: loading || session !== null, loading, open, session };
}
