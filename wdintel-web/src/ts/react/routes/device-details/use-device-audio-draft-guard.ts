import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FORCED_NAVIGATION_EVENT,
  registerNavigationGuard,
} from '../../../browser/navigation-guard';
import type { DeviceAudioEditorState } from './use-device-audio-editor';

type Choice = 'save' | 'discard' | 'cancel';
export function useDeviceAudioDraftGuard(editor: DeviceAudioEditorState) {
  const latest = useRef(editor);
  latest.current = editor;
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ resolve: (allow: boolean) => void } | null>(null);
  const running = useRef(false);
  const forced = useRef(false);
  const decide = useCallback(() => {
    if (forced.current || pending.current) return Promise.resolve(false);
    if (!latest.current.hasUnsavedChanges()) return Promise.resolve(true);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = { resolve };
    });
  }, []);
  const finish = useCallback((allow: boolean) => {
    const decision = pending.current;
    pending.current = null;
    setOpen(false);
    setSaving(false);
    decision?.resolve(allow);
  }, []);
  const choose = useCallback(
    async (choice: Choice) => {
      const decision = pending.current;
      if (!decision) return;
      if (choice === 'cancel') finish(false);
      else if (choice === 'discard') {
        latest.current.discard();
        finish(true);
      } else if (!latest.current.saving && latest.current.canEdit) {
        setSaving(true);
        const saved = await latest.current.save();
        if (pending.current !== decision || forced.current) return;
        setSaving(false);
        if (saved && !latest.current.hasUnsavedChanges()) finish(true);
      }
    },
    [finish],
  );
  const requestIntent = useCallback(
    async (intent: () => void | Promise<void>) => {
      if (running.current || forced.current) return false;
      if (!latest.current.hasUnsavedChanges()) {
        const result = intent();
        if (result instanceof Promise) {
          running.current = true;
          try {
            await result;
          } finally {
            running.current = false;
          }
        }
        return true;
      }
      running.current = true;
      try {
        if (!(await decide()) || forced.current) return false;
        await intent();
        return true;
      } finally {
        running.current = false;
      }
    },
    [decide],
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!forced.current && latest.current.hasUnsavedChanges()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const force = () => {
      forced.current = true;
      window.removeEventListener('beforeunload', unload);
      finish(false);
    };
    window.addEventListener('beforeunload', unload);
    window.addEventListener(FORCED_NAVIGATION_EVENT, force, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener(FORCED_NAVIGATION_EVENT, force, true);
      pending.current?.resolve(false);
      pending.current = null;
    };
  }, [decide, finish]);
  const protectedDraft = editor.hasUnsavedChanges();
  useEffect(() => {
    if (protectedDraft && !forced.current) return registerNavigationGuard(decide);
  }, [decide, protectedDraft]);
  return { open, saving, requestIntent, choose };
}
export type DeviceAudioDraftGuard = ReturnType<typeof useDeviceAudioDraftGuard>;
