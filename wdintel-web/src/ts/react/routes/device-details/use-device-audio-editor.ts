import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DeviceAudioDetails,
  DeviceAudioTranscription,
  DeviceAudioAutomaticTranscriptionSnapshot,
  DeviceAudioTranscriptionAvailability,
} from '../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import {
  getDeviceAudioDetail,
  saveDeviceAudioTranscription,
} from '../../services/api/device-audio';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { formatDeviceErrorMessage } from '../devices/helpers';
import type { AudioProcessingDetails } from './use-device-audio-processing';

type EditorPhase =
  'loading' | 'loadError' | 'ready' | 'saving' | 'saveError' | 'unknownOutcome' | 'conflict';
type EditorState = {
  scope: string;
  phase: EditorPhase;
  detail: DeviceAudioDetails | null;
  confirmed: DeviceAudioTranscription | null;
  baseline: string;
  automaticView: boolean;
  automaticNotice: boolean;
  draft: string;
  generation: number;
  saving: boolean;
  accessDenied: boolean;
  conflict: DeviceAudioTranscription | null;
  message: string | null;
};
type SaveSnapshot = {
  scope: string;
  session: number;
  text: string;
  version: string;
  generation: number;
  conflict?: boolean;
};
const pendingWrites = new Map<string, { promise: Promise<boolean>; snapshot: SaveSnapshot }>();
function empty(scope: string): EditorState {
  return {
    scope,
    phase: 'loading',
    detail: null,
    confirmed: null,
    baseline: '',
    automaticView: false,
    automaticNotice: false,
    draft: '',
    generation: 0,
    saving: false,
    accessDenied: false,
    conflict: null,
    message: null,
  };
}

function displayText(detail: DeviceAudioDetails, manual = detail.transcription.text) {
  return manual !== '' ? manual : (detail.automaticTranscription?.text ?? '');
}

function dirty(state: EditorState) {
  return state.confirmed !== null && state.draft !== state.baseline;
}

function useEditorContext(deviceId: string, audioId: string | null, editable: boolean) {
  const scope = `${deviceId}:${audioId}`;
  const [stored, setStored] = useState(() => empty(scope));
  const current = stored.scope === scope ? stored : empty(scope);
  const state = useRef(current);
  state.current = current;
  const context = useRef({ scope, session: 0 });
  if (context.current.scope !== scope)
    context.current = { scope, session: context.current.session + 1 };
  const session = context.current.session;
  const permission = useRef(editable);
  permission.current = editable;
  const writes = useRef(pendingWrites);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const lastSnapshot = useRef<SaveSnapshot | null>(null);
  const readEpoch = useRef(0);
  const reader = useRef<AbortController | null>(null);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const active = useCallback(
    () => mounted.current && context.current.scope === scope && context.current.session === session,
    [scope, session],
  );
  const update = useCallback(
    (patch: Partial<EditorState>) => {
      if (!active()) return;
      const next = { ...state.current, ...patch, scope };
      state.current = next;
      setStored(next);
    },
    [active, scope],
  );
  const showError = useCallback(
    (message: string) => {
      if (active()) notifyRef.current({ severity: 'error', message });
    },
    [active],
  );

  return {
    current,
    scope,
    state,
    session,
    context,
    permission,
    writes,
    lastSnapshot,
    readEpoch,
    reader,
    active,
    update,
    showError,
  };
}
type EditorContext = ReturnType<typeof useEditorContext>;

function useEditorReader(
  editor: EditorContext,
  deviceId: string,
  audioId: string | null,
  processing?: AudioProcessingDetails,
) {
  const { scope, state, writes, readEpoch, reader, active, update, showError } = editor;
  const processingRef = useRef(processing);
  processingRef.current = processing;
  const read = useCallback(
    async (snapshot?: SaveSnapshot, conflict = false, waitForWrite = true) => {
      if (audioId === null) return false;
      const epoch = ++readEpoch.current;
      reader.current?.abort();
      const request = new AbortController();
      reader.current = request;
      try {
        if (!snapshot && waitForWrite) await writes.current.get(scope)?.promise;
        if (!active() || request.signal.aborted) return false;
        const processingEpoch = processingRef.current?.processingEpoch();
        const permissionEpoch = processingRef.current?.beginProcessingPermissionRead(audioId);
        let detail = await getDeviceAudioDetail({ deviceId, audioId }, { signal: request.signal });
        if (!active() || request.signal.aborted || epoch !== readEpoch.current) return false;
        if (processingEpoch !== undefined && processingRef.current)
          detail = processingRef.current.reconcileProcessingDetail(
            detail,
            processingEpoch,
            permissionEpoch,
          );
        const previous = state.current;
        const changed = snapshot
          ? conflict || detail.transcription.text !== snapshot.text
          : previous.confirmed !== null &&
            dirty(previous) &&
            detail.transcription.textVersion !== previous.confirmed.textVersion;
        if (changed) {
          update({
            detail,
            accessDenied: false,
            phase: 'conflict',
            conflict: detail.transcription,
            message: 'Транскрипцію змінено. Зіставте актуальний текст зі своєю чернеткою.',
          });
        } else {
          const baseline = displayText(detail);
          const preserveDraft = snapshot
            ? previous.generation !== snapshot.generation
            : dirty(previous);
          update({
            detail,
            accessDenied: false,
            confirmed: detail.transcription,
            baseline: preserveDraft && !snapshot ? previous.baseline : baseline,
            draft: preserveDraft ? previous.draft : baseline,
            automaticView: previous.automaticView && detail.transcription.text !== '',
            conflict: null,
            phase: 'ready',
            message: snapshot
              ? 'Результат попереднього запиту невідомий. Актуальний текст перечитано.'
              : null,
          });
        }
        return !changed;
      } catch (error) {
        if (
          !active() ||
          request.signal.aborted ||
          epoch !== readEpoch.current ||
          isAbortError(error)
        )
          return false;
        const message = `Помилка читання транскрипції: ${formatDeviceErrorMessage(error)}`;
        const denied = error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
        update({
          phase: snapshot ? 'unknownOutcome' : 'loadError',
          message,
          accessDenied: denied,
          ...(denied && state.current.detail
            ? { detail: { ...state.current.detail, canEdit: false } }
            : {}),
        });
        showError(message);
        return false;
      }
    },
    [active, audioId, deviceId, scope, showError, update],
  );

  useEffect(() => {
    update(empty(scope));
    if (audioId !== null) void read();
    return () => {
      ++readEpoch.current;
      reader.current?.abort();
    };
  }, [audioId, read, scope, update]);

  return read;
}

function useEditorWriter(
  editor: EditorContext,
  deviceId: string,
  audioId: string | null,
  read: ReturnType<typeof useEditorReader>,
) {
  const { scope, state, session, permission, writes, lastSnapshot, active, update, showError } =
    editor;
  const save = useCallback(async () => {
    const current = state.current;
    if (
      !active() ||
      audioId === null ||
      !permission.current ||
      !current.detail?.canEdit ||
      !current.confirmed ||
      writes.current.has(scope)
    )
      return false;
    if (current.conflict || current.phase === 'unknownOutcome') return false;
    if (!dirty(current)) return true;
    const snapshot: SaveSnapshot = {
      scope,
      session,
      text: current.draft,
      version: current.confirmed.textVersion,
      generation: current.generation,
    };
    lastSnapshot.current = snapshot;
    update({ phase: 'saving', saving: true, message: null });
    const promise = (async () => {
      try {
        const response = await saveDeviceAudioTranscription({
          deviceId,
          audioId,
          text: snapshot.text,
          expectedTextVersion: snapshot.version,
        });
        if (!active()) return false;
        const baseline = state.current.detail
          ? displayText(state.current.detail, response.transcription.text)
          : response.transcription.text;
        update({
          confirmed: response.transcription,
          baseline,
          automaticView: state.current.automaticView && response.transcription.text !== '',
          ...(state.current.generation === snapshot.generation ? { draft: baseline } : {}),
          detail: state.current.detail
            ? { ...state.current.detail, transcription: response.transcription }
            : null,
          phase: 'ready',
          conflict: null,
          message: null,
        });
        return !dirty(state.current);
      } catch (error) {
        if (!active()) return false;
        const conflict = error instanceof HttpRequestError && error.status === 409;
        const unknown =
          !(error instanceof HttpRequestError) || error.status === 0 || error.status >= 500;
        const message = conflict
          ? 'Транскрипцію вже змінено.'
          : unknown
            ? 'Результат збереження невідомий. Перечитуємо актуальний текст.'
            : `Помилка збереження транскрипції: ${formatDeviceErrorMessage(error)}`;
        update({ phase: unknown ? 'unknownOutcome' : 'saveError', message });
        showError(message);
        if (conflict) lastSnapshot.current = { ...snapshot, conflict: true };
        if (conflict || unknown) await read(snapshot, conflict);
        else if (error instanceof HttpRequestError && [401, 403, 404].includes(error.status)) {
          update({ detail: { ...current.detail!, canEdit: false } });
          await read(undefined, false, false);
          update({
            message,
            phase: state.current.phase === 'ready' ? 'saveError' : state.current.phase,
          });
        }
        return false;
      } finally {
        writes.current.delete(scope);
        update({ saving: false });
      }
    })();
    writes.current.set(scope, { promise, snapshot });
    return promise;
  }, [active, audioId, deviceId, read, scope, session, showError, update]);

  return save;
}

export function useDeviceAudioEditor(
  deviceId: string,
  audioId: string | null,
  editable: boolean,
  processing?: AudioProcessingDetails,
) {
  const editor = useEditorContext(deviceId, audioId, editable);
  const { current, scope, session, state, permission, writes, lastSnapshot, update } = editor;
  const read = useEditorReader(editor, deviceId, audioId, processing);
  const save = useEditorWriter(editor, deviceId, audioId, read);
  const canEdit =
    editable &&
    current.detail?.canEdit === true &&
    current.confirmed !== null &&
    !['loading', 'loadError'].includes(current.phase);
  const setDraft = useCallback(
    (draft: string) => {
      if (
        permission.current &&
        state.current.detail?.canEdit &&
        state.current.confirmed &&
        !state.current.automaticView
      ) {
        update({ draft, generation: state.current.generation + 1 });
      }
    },
    [update],
  );
  const acceptCurrent = useCallback(
    (useServerText: boolean) => {
      const previous = state.current;
      if (!previous.conflict || previous.saving) return;
      update({
        confirmed: previous.conflict,
        automaticView: previous.conflict.text === '' ? false : previous.automaticView,
        baseline: previous.detail
          ? displayText(previous.detail, previous.conflict.text)
          : previous.conflict.text,
        draft:
          useServerText && previous.detail
            ? displayText(previous.detail, previous.conflict.text)
            : previous.draft,
        generation: previous.generation + 1,
        conflict: null,
        phase: 'ready',
        message: null,
      });
    },
    [update],
  );
  const discard = useCallback(() => {
    const current = state.current;
    const base = current.conflict ?? current.confirmed;
    const baseline =
      base && current.detail ? displayText(current.detail, base.text) : current.baseline;
    update({
      draft: writes.current.get(scope)?.snapshot.text ?? baseline,
      baseline,
      confirmed: base,
      automaticView: base?.text === '' ? false : current.automaticView,
      generation: current.generation + 1,
      conflict: null,
      phase: current.saving ? 'saving' : base ? 'ready' : current.phase,
      message: null,
    });
  }, [scope, update]);
  const reload = useCallback(async () => {
    const snapshot = lastSnapshot.current;
    const pending =
      state.current.phase === 'unknownOutcome' &&
      snapshot?.scope === scope &&
      snapshot.session === session
        ? snapshot
        : undefined;
    await read(pending, pending?.conflict);
  }, [read, scope, session]);
  const hasUnsavedChanges = useCallback(() => {
    const current = state.current;
    return (
      current.confirmed !== null &&
      (dirty(current) ||
        current.saving ||
        current.conflict !== null ||
        current.phase === 'unknownOutcome')
    );
  }, []);
  const setAutomaticView = useCallback(
    (automatic: boolean) => {
      if (automatic && !state.current.detail?.automaticTranscription?.text) return;
      update({ automaticView: automatic, automaticNotice: false });
    },
    [update],
  );
  const denyAccess = useCallback(() => {
    if (!editor.active()) return;
    update({
      accessDenied: true,
      ...(state.current.detail ? { detail: { ...state.current.detail, canEdit: false } } : {}),
    });
  }, [editor.active, update]);
  const mergeAutomatic = useCallback(
    (
      snapshot: DeviceAudioAutomaticTranscriptionSnapshot | null,
      availability: DeviceAudioTranscriptionAvailability,
    ) => {
      const previous = state.current;
      if (!editor.active() || !previous.detail || !previous.confirmed) return;
      const detail = {
        ...previous.detail,
        automaticTranscription: snapshot ?? previous.detail.automaticTranscription,
        transcriptionAvailability: availability,
        canEdit: availability.canEditManual,
      };
      const clean =
        !dirty(previous) &&
        !previous.saving &&
        previous.conflict === null &&
        previous.phase === 'ready';
      const arrived =
        snapshot?.text != null && snapshot.text !== previous.detail.automaticTranscription?.text;
      const baseline = displayText(detail, previous.confirmed.text);
      update({
        detail,
        ...(clean ? { baseline, draft: baseline } : {}),
        automaticNotice: previous.automaticNotice || (arrived && !clean),
      });
    },
    [editor.active, update],
  );
  return {
    ...current,
    hasUnsavedChanges,
    canEdit,
    dirty: dirty(current),
    setDraft,
    save,
    reload,
    acceptCurrent,
    discard,
    setAutomaticView,
    mergeAutomatic,
    denyAccess,
  };
}
export type DeviceAudioEditorState = ReturnType<typeof useDeviceAudioEditor>;
