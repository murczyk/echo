import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceAudio, DeviceAudioDetails } from '../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { getDeviceAudioDetail, setDeviceAudioProcessing } from '../../services/api/device-audio';
import { HttpRequestError } from '../../services/api/client';
import { formatDeviceErrorMessage } from '../devices/helpers';

type ProcessingAction = {
  target: boolean;
  phase: 'pending' | 'unknownOutcome' | 'conflict' | 'ready' | 'rejected';
  message: string | null;
  canEdit?: boolean;
  accessDenied?: boolean;
  requiresConflict?: boolean;
};
type ProcessingContext = {
  scope: string;
  epoch: number;
  known: Map<string, DeviceAudio>;
  observedEpochs: Map<string, number>;
  actions: Record<string, ProcessingAction>;
  permissions: Record<string, { epoch: number; canEdit?: boolean; accessDenied?: boolean }>;
  reconciling: Set<string>;
};
export type AudioProcessingDetails = {
  processingEpoch: () => number;
  beginProcessingPermissionRead: (id: string) => number;
  reconcileProcessingDetail: (
    detail: DeviceAudioDetails,
    epoch: number,
    permissionEpoch?: number,
  ) => DeviceAudioDetails;
};

export function useDeviceAudioProcessing(
  deviceId: string,
  canRead: boolean,
  callbacks: {
    row: (id: string) => DeviceAudio | undefined;
    confirm: (audio: DeviceAudio, previous?: DeviceAudio) => void;
  },
) {
  const scope = `${deviceId}:${canRead}`;
  const context = useRef<ProcessingContext>({
    scope,
    epoch: 0,
    known: new Map(),
    observedEpochs: new Map(),
    actions: {},
    permissions: {},
    reconciling: new Set(),
  });
  if (context.current.scope !== scope)
    context.current = {
      scope,
      epoch: context.current.epoch + 1,
      known: new Map(),
      observedEpochs: new Map(),
      actions: {},
      permissions: {},
      reconciling: new Set(),
    };
  const current = context.current;
  const [, render] = useState(0);
  const mounted = useRef(true);
  const latest = useRef(callbacks);
  latest.current = callbacks;
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const active = useCallback(
    () => mounted.current && context.current === current && canRead,
    [current, canRead],
  );
  const update = useCallback(
    (id: string, action: ProcessingAction) => {
      if (!active()) return;
      current.actions = { ...current.actions, [id]: action };
      render((value) => value + 1);
    },
    [active, current],
  );
  const beginProcessingPermissionRead = useCallback(
    (id: string) => {
      const previous = current.permissions[id];
      const epoch = (previous?.epoch ?? 0) + 1;
      current.permissions[id] = { ...previous, epoch };
      return epoch;
    },
    [current],
  );
  const confirmPermission = useCallback(
    (id: string, epoch: number, canEdit: boolean, accessDenied = false) => {
      if (!active() || current.permissions[id]?.epoch !== epoch) return;
      current.permissions[id] = { epoch, canEdit, accessDenied };
      render((value) => value + 1);
    },
    [active, current],
  );
  const confirm = useCallback(
    (audio: DeviceAudio) => {
      if (!active()) return;
      const previous = current.known.get(audio.id) ?? latest.current.row(audio.id);
      current.known.set(audio.id, audio);
      if (previous && previous.processingVersion === audio.processingVersion) return;
      ++current.epoch;
      current.observedEpochs.set(audio.id, current.epoch);
      latest.current.confirm(audio, previous);
    },
    [active, current],
  );
  const reconcile = useCallback(
    async (id: string, conflict = false, parallel = false) => {
      const action = current.actions[id];
      if (!active() || !action || current.reconciling.has(id)) return;
      current.reconciling.add(id);
      render((value) => value + 1);
      const previous = current.known.get(id);
      const permissionEpoch = beginProcessingPermissionRead(id);
      try {
        let detail = await getDeviceAudioDetail({ deviceId, audioId: id });
        if (!active() || current.actions[id] !== action) return;
        const known = current.known.get(id);
        if (known && known !== previous) detail = { ...detail, audio: known };
        confirm(detail.audio);
        confirmPermission(id, permissionEpoch, detail.canEdit);
        const changed = conflict || detail.audio.processed !== action.target;
        update(id, {
          ...action,
          phase: changed ? 'conflict' : 'ready',
          message: changed
            ? 'Статус уже змінено. Перегляньте актуальний стан і явно повторіть обрану дію.'
            : parallel
              ? 'Актуальний статус перечитано після паралельної зміни.'
              : 'Результат попереднього запиту невідомий. Актуальний статус перечитано.',
        });
      } catch (error) {
        if (!active() || current.actions[id] !== action) return;
        const message = `Не вдалося звірити статус: ${formatDeviceErrorMessage(error)}`;
        const denied = error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
        if (denied) confirmPermission(id, permissionEpoch, false, true);
        update(id, {
          ...action,
          phase: 'unknownOutcome',
          message,
        });
        notifyRef.current({ severity: 'error', message });
      } finally {
        current.reconciling.delete(id);
        if (active()) render((value) => value + 1);
      }
    },
    [active, beginProcessingPermissionRead, confirm, confirmPermission, current, deviceId, update],
  );
  const reconcileRejected = useCallback(
    async (id: string, action: ProcessingAction) => {
      const known = current.known.get(id);
      const permissionEpoch = beginProcessingPermissionRead(id);
      const unchanged = () => active() && current.actions[id] === action;
      try {
        const detail = await getDeviceAudioDetail({ deviceId, audioId: id });
        if (!unchanged()) return;
        const latestAudio = current.known.get(id);
        confirm(
          latestAudio && latestAudio !== known
            ? {
                ...detail.audio,
                processed: latestAudio.processed,
                processingVersion: latestAudio.processingVersion,
              }
            : detail.audio,
        );
        confirmPermission(id, permissionEpoch, detail.canEdit);
      } catch (error) {
        if (!unchanged() || current.permissions[id]?.epoch !== permissionEpoch) return;
        const denied = error instanceof HttpRequestError && [401, 403, 404].includes(error.status);
        const message = `Не вдалося звірити доступ до аудіо: ${formatDeviceErrorMessage(error)}`;
        confirmPermission(id, permissionEpoch, false, denied);
        update(id, {
          ...action,
          message: `${action.message} ${message}`,
        });
        notifyRef.current({ severity: 'error', message });
      }
    },
    [active, beginProcessingPermissionRead, confirm, confirmPermission, current, deviceId, update],
  );
  const rejectProcessing = useCallback(
    async (id: string, target: boolean, error: unknown, permissionEpoch: number) => {
      const conflict = error instanceof HttpRequestError && error.status === 409;
      const unknown =
        !(error instanceof HttpRequestError) || error.status === 0 || error.status >= 500;
      const message = conflict
        ? 'Статус аудіо вже змінено.'
        : unknown
          ? 'Результат зміни статусу невідомий. Перечитуємо актуальний стан.'
          : `Помилка зміни статусу: ${formatDeviceErrorMessage(error)}`;
      const action: ProcessingAction = {
        target,
        phase: unknown || conflict ? 'unknownOutcome' : 'rejected',
        message,
        requiresConflict: conflict,
      };
      update(id, action);
      notifyRef.current({ severity: 'error', message });
      if (conflict || unknown) await reconcile(id, conflict);
      else if (error instanceof HttpRequestError && [401, 403, 404].includes(error.status)) {
        confirmPermission(id, permissionEpoch, false, current.permissions[id]?.accessDenied);
        await reconcileRejected(id, action);
      }
    },
    [confirmPermission, current, reconcile, reconcileRejected, update],
  );
  const setProcessed = useCallback(
    async (id: string, target: boolean) => {
      const previous = current.actions[id];
      const audio = current.known.get(id) ?? latest.current.row(id);
      if (
        !active() ||
        !audio ||
        previous?.phase === 'pending' ||
        previous?.phase === 'unknownOutcome'
      )
        return;
      current.known.set(id, audio);
      const snapshot: ProcessingAction = { target, phase: 'pending', message: null };
      const permissionEpoch = beginProcessingPermissionRead(id);
      update(id, snapshot);
      try {
        const response = await setDeviceAudioProcessing({
          deviceId,
          audioId: id,
          processed: target,
          expectedProcessingVersion: audio.processingVersion,
        });
        if (!active() || current.actions[id] !== snapshot) return;
        confirmPermission(id, permissionEpoch, true);
        const known = current.known.get(id);
        if (
          known &&
          known.processingVersion !== audio.processingVersion &&
          known.processingVersion !== response.processingVersion
        ) {
          update(id, {
            target,
            phase: 'unknownOutcome',
            message: 'Звіряємо актуальний статус після паралельної зміни.',
          });
          await reconcile(id, false, true);
          return;
        }
        confirm({
          ...audio,
          processed: response.processed,
          processingVersion: response.processingVersion,
        });
        update(id, { target, phase: 'ready', message: null });
      } catch (error) {
        if (!active() || current.actions[id] !== snapshot) return;
        await rejectProcessing(id, target, error, permissionEpoch);
      }
    },
    [
      active,
      beginProcessingPermissionRead,
      confirm,
      confirmPermission,
      current,
      deviceId,
      reconcile,
      rejectProcessing,
      update,
    ],
  );
  const processingEpoch = useCallback(() => context.current.epoch, []);
  const acceptProcessingPage = useCallback(
    (rows: DeviceAudio[]) => {
      if (!active()) return;
      ++current.epoch;
      for (const row of rows) {
        current.known.set(row.id, row);
        current.observedEpochs.set(row.id, current.epoch);
      }
    },
    [active, current],
  );
  const reconcileProcessingDetail = useCallback(
    (detail: DeviceAudioDetails, epoch: number, permissionEpoch?: number) => {
      const current = context.current;
      confirmPermission(
        detail.audio.id,
        permissionEpoch ?? beginProcessingPermissionRead(detail.audio.id),
        detail.canEdit,
      );
      const known = current.known.get(detail.audio.id);
      if ((current.observedEpochs.get(detail.audio.id) ?? 0) > epoch && known)
        return {
          ...detail,
          audio: {
            ...detail.audio,
            processed: known.processed,
            processingVersion: known.processingVersion,
          },
        };
      confirm(detail.audio);
      return detail;
    },
    [beginProcessingPermissionRead, confirm, confirmPermission],
  );
  const reconcileProcessing = useCallback(
    async (id: string) => {
      if (current.actions[id]?.phase === 'unknownOutcome')
        await reconcile(id, current.actions[id].requiresConflict);
    },
    [current, reconcile],
  );
  const processingAudio = useCallback(
    (id: string) => current.known.get(id) ?? latest.current.row(id),
    [current],
  );
  return {
    processing: Object.fromEntries(
      Object.entries(current.actions).map(([id, action]) => [
        id,
        {
          ...action,
          canEdit: current.permissions[id]?.canEdit,
          accessDenied: current.permissions[id]?.accessDenied,
          reconciling: current.reconciling.has(id),
        },
      ]),
    ),
    setProcessed,
    reconcileProcessing,
    processingEpoch,
    beginProcessingPermissionRead,
    reconcileProcessingDetail,
    processingAudio,
    acceptProcessingPage,
  };
}
