import type { Dayjs } from 'dayjs';
import type { InboxMessage } from '../../../../../Bindings';
import type Uppy from '@uppy/core';
import type { UppyFile } from '@uppy/core';
import { useEffect, useRef } from 'react';

import {
  createDeviceName,
  submitDirect,
  editDirectSubmit,
  formatDirectSubmitError,
  type DirectSubmitResponse,
} from '../../../services/api/direct-submit';
import type { RecentValues } from './useRecentValues';
import {
  compatibleMessageUnitSelection,
  isMessageUnitSelectionValid,
  MESSAGE_UNIT_SELECTION_ERROR,
} from './message-unit-selection';
import {
  DO_NOT_SEND_GROUP_VALUE,
  parseCoords,
  type MessageFormData,
} from './manage-message-drawer.schema';
import { combineDateTimeToMs, formatDateInputValueInTimeZone } from '../../../utils/misc';
import { MAX_MESSAGE_ATTACHMENTS } from './useMessageUppy';
import { fallbackFailedMessageUploads, messageUploadFailure } from './message-upload-fallback';

type SubmitOptions = {
  engagedMessageId?: number;
  replySourceUnavailable?: boolean;
  replyGroupMasterKey?: string | null;
  busy: boolean;
  radioFeaturesAllowed: boolean;
  cyberEchoEnabled: boolean;
  isEditMode: boolean;
  isReportMode: boolean;
  isReportCreateMode: boolean;
  editTarget: { id: number; message: InboxMessage } | null | undefined;
  reportSource:
    { id: number; message: InboxMessage; senderName?: string | null } | null | undefined;
  existingMedia: InboxMessage['media'];
  onSubmitEdit: ((id: number, message: InboxMessage) => void | Promise<void>) | undefined;
  tagsLoaded: boolean;
  setSubmitting: (val: boolean) => void;
  setErrorMsg: (msg: string | null) => void;
  uppy: Uppy<any, any>;
  addValues: (vals: Partial<RecentValues>) => void;
  onCreated?: (result: DirectSubmitResponse) => void | Promise<void>;
  onEditSuccess?: (result: DirectSubmitResponse) => void | Promise<void>;
  handleDrawerCloseAfterSubmit: () => void;
  handleCreateSuccess: (data: MessageFormData) => void;
};

export function useMessageSubmit({
  busy,
  radioFeaturesAllowed,
  cyberEchoEnabled,
  isEditMode,
  isReportMode,
  isReportCreateMode,
  editTarget,
  reportSource,
  engagedMessageId,
  replySourceUnavailable,
  replyGroupMasterKey,
  existingMedia,
  onSubmitEdit,
  tagsLoaded,
  setSubmitting,
  setErrorMsg,
  uppy,
  addValues,
  onCreated,
  onEditSuccess,
  handleDrawerCloseAfterSubmit,
  handleCreateSuccess,
}: SubmitOptions) {
  const sourceUnavailable = useRef(replySourceUnavailable);
  sourceUnavailable.current = replySourceUnavailable;
  const mounted = useRef(false);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = true;
    const cancel = () => submission.current?.abort();
    uppy.on('cancel-all', cancel);
    return () => {
      mounted.current = false;
      cancel();
      uppy.off('cancel-all', cancel);
    };
  }, [uppy]);

  const onSubmit = async (data: MessageFormData) => {
    if (busy || submission.current || !mounted.current) return;
    if (
      !isEditMode &&
      !isMessageUnitSelectionValid(data.unit, data.unitSelection, data.unitNetworkSelection)
    ) {
      setErrorMsg(MESSAGE_UNIT_SELECTION_ERROR);
      return;
    }
    let createdResult: DirectSubmitResponse | null = null;

    const hasTextContent = isReportMode
      ? Boolean(data.full_body?.trim())
      : Boolean(data.text?.trim() || data.full_body?.trim());
    const uppyFiles = uppy.getFiles();
    const hasNewFiles = uppyFiles.length > 0;

    // In edit mode, check if there are existing media files that are not deleted
    const deletedMediaIds = new Set(data.deleted_media_ids ?? []);
    const existingMediaIds = new Set(existingMedia.map((media) => media.id));
    const replacedMediaIds = new Set(
      uppyFiles.flatMap((file) => {
        const mediaId = file.meta?.replaces_media_id;
        return typeof mediaId === 'string' && existingMediaIds.has(mediaId) ? [mediaId] : [];
      }),
    );
    const retainedMediaIds = existingMedia
      .filter((media) => !deletedMediaIds.has(media.id) && !replacedMediaIds.has(media.id))
      .map((media) => media.id);
    const retainedMediaCount = isEditMode || isReportCreateMode ? retainedMediaIds.length : 0;
    const hasExistingMedia = retainedMediaCount > 0;

    if (isReportMode && !hasTextContent) {
      setErrorMsg('Текст розвіддонесення є обов’язковим');
      return;
    }
    if (!hasTextContent && !hasNewFiles && !hasExistingMedia) {
      setErrorMsg("Текст повідомлення або вкладення є обов'язковими");
      return;
    }
    if (retainedMediaCount + uppyFiles.length > MAX_MESSAGE_ATTACHMENTS) {
      setErrorMsg(`Кількість вкладень не може перевищувати ${MAX_MESSAGE_ATTACHMENTS}`);
      return;
    }

    const controller = new AbortController();
    submission.current = controller;
    const { signal } = controller;
    setSubmitting(true);
    setErrorMsg(null);

    try {
      let deviceNameId: number | null | undefined;
      const deviceName = cyberEchoEnabled ? data.deviceName?.trim() : undefined;
      if (deviceName) {
        const device = await createDeviceName(deviceName);
        signal.throwIfAborted();
        deviceNameId = device.id;
      } else if (cyberEchoEnabled && isEditMode && editTarget?.message.deviceName) {
        deviceNameId = null;
      }

      const files = uppy.getFiles();
      const uploadUrls: string[] = [];
      const replacementUploads: { media_id: string; upload_url: string }[] = [];

      if (files.length > 0) {
        const uploadResult = await uppy.upload();
        signal.throwIfAborted();
        if (!uploadResult) {
          throw new Error('Помилка завантаження файлів (no result)');
        }
        const failed = await fallbackFailedMessageUploads(uppy, uploadResult.failed || [], signal);
        signal.throwIfAborted();
        if (failed.length > 0) {
          throw new Error(formatMessageUploadError(uppy, failed[0]));
        }

        for (const file of uppy.getFiles()) {
          const url = file.tus?.uploadUrl || file.uploadURL || file.response?.uploadURL;
          if (url) {
            const replacesMediaId = file.meta?.replaces_media_id;
            if (isEditMode && typeof replacesMediaId === 'string') {
              replacementUploads.push({ media_id: replacesMediaId, upload_url: url });
            } else {
              uploadUrls.push(url);
            }
          } else {
            throw new Error(`Помилка: не знайдено URL для файлу ${file.name}`);
          }
        }
      }

      const coordsResult = parseCoords(data.coords ?? '');

      const dateValue = data.date as Dayjs | null;
      const timeValue = data.time as Dayjs | null;
      let timestamp: string | undefined;
      if (dateValue || timeValue) {
        const date = dateValue?.format('YYYY-MM-DD') ?? formatDateInputValueInTimeZone(new Date());
        const time = timeValue?.format('HH:mm') ?? '12:00';
        const timestampMs = combineDateTimeToMs(date, time);
        if (timestampMs != null) timestamp = new Date(timestampMs).toISOString();
      }

      const dmrRows = (radioFeaturesAllowed ? (data.dmr ?? []) : []).filter((metadata) =>
        Object.values(metadata).some((value) => value?.trim()),
      );
      const primaryCc = optionalInteger(dmrRows[0]?.cc);
      const networkSignalName = radioFeaturesAllowed
        ? data.network_signal_name?.trim() || undefined
        : undefined;
      const networkName = data.network_name?.trim() || undefined;
      let networkObj: any;
      if (networkSignalName || networkName) {
        networkObj = {
          signal_name: networkSignalName,
          cc: primaryCc,
          name: networkName,
        };
      }

      const dmrArr = dmrRows.map((metadata) => ({
        timestamp: timestamp || new Date().toISOString(),
        freq: data.freq?.trim() ?? '',
        signal_name: 'DMR',
        cc: optionalInteger(metadata.cc),
        sender_id: optionalInteger(metadata.sender_id),
        sender_name: metadata.sender_name?.trim() || undefined,
        call_group_id: optionalInteger(metadata.call_group_id),
        call_group_name: metadata.call_group_name?.trim() || undefined,
        hash_id: metadata.hash_id?.trim() || undefined,
      }));
      const recentValues = buildRecentValues(data, dmrRows, cyberEchoEnabled);
      const unitSelection = compatibleMessageUnitSelection(data.unit, data.unitSelection);

      const payload = {
        full_body: data.full_body?.trim() || undefined,
        text: shortBodyForSubmit(data, isEditMode ? editTarget : null),
        comment: isReportCreateMode ? undefined : data.comment?.trim() || undefined,
        signal_group_master_key:
          engagedMessageId != null && replyGroupMasterKey
            ? replyGroupMasterKey
            : data.signalGroupMasterKey === DO_NOT_SEND_GROUP_VALUE
              ? null
              : data.signalGroupMasterKey?.trim() || (isReportMode ? null : ''),
        source_signal_group_master_key: isEditMode ? editTarget?.message.groupMasterKey : undefined,
        device_name_id: deviceNameId,
        upload_urls: uploadUrls.length ? uploadUrls : null,
        attachment_updates: buildAttachmentUpdates(
          existingMedia,
          data.attachment_file_names ?? {},
          replacementUploads,
          isEditMode || isReportCreateMode,
          replacedMediaIds,
        ),
        freq: radioFeaturesAllowed
          ? data.freq || undefined
          : (editTarget?.message.freq ?? undefined),
        coords: coordsResult,
        to: data.callsigns || [],
        tags: isEditMode && !tagsLoaded ? undefined : (data.tags ?? []),
        timestamp,
        is_time_null:
          dateValue ||
          timeValue ||
          editTarget?.message.timestamp != null ||
          (!isEditMode && !isReportCreateMode)
            ? timeValue == null
            : undefined,
        post: radioFeaturesAllowed
          ? data.post || undefined
          : (editTarget?.message.post ?? undefined),
        unit: data.unit || undefined,
        unit_id: unitSelection?.id,
        create_unit: unitSelection?.create,
        locations: data.locations || [],
        network: networkObj,
        dmr: radioFeaturesAllowed
          ? dmrArr
          : (editTarget?.message.metadata ?? []).map((metadata) => ({
              timestamp:
                editTarget?.message.timestamp != null
                  ? new Date(editTarget.message.timestamp).toISOString()
                  : new Date(editTarget?.message.createdAt ?? 0).toISOString(),
              freq: editTarget?.message.freq ?? '',
              signal_name: 'DMR',
              cc: optionalInteger(metadata.colorCode),
              sender_id: optionalInteger(metadata.senderId),
              sender_name: metadata.senderName ?? undefined,
              call_group_id: optionalInteger(metadata.callGroupId),
              call_group_name: metadata.callGroupName ?? undefined,
              hash_id: metadata.hashId ?? undefined,
            })),
        deleted_media_ids: isEditMode ? (data.deleted_media_ids ?? []) : [],
        retained_media_ids: isReportCreateMode ? retainedMediaIds : undefined,
        engaged_message_id:
          !isEditMode && !sourceUnavailable.current ? engagedMessageId : undefined,
        parent_signal_message_ids: isReportCreateMode ? [reportSource!.id] : undefined,
        copy_source_signal_message_ids: isReportCreateMode ? [reportSource!.id] : undefined,
      };

      if (isEditMode && editTarget) {
        const res = await editDirectSubmit(editTarget.id, payload);
        signal.throwIfAborted();
        addValues(recentValues);
        let editAppliedLocally = false;
        const groupChanged =
          payload.signal_group_master_key !== (editTarget.message.groupMasterKey ?? null);
        if (onSubmitEdit && res.message && !groupChanged) {
          try {
            await onSubmitEdit(editTarget.id, res.message);
            editAppliedLocally = true;
          } catch (error) {
            console.error('Error handling edited message', error);
          }
        }
        handleDrawerCloseAfterSubmit();
        if (!editAppliedLocally) {
          try {
            await onEditSuccess?.(res);
          } catch (error) {
            console.error('Error handling edit success', error);
          }
        }
      } else {
        const result = await submitDirect(payload);
        signal.throwIfAborted();
        addValues(recentValues);
        handleCreateSuccess(data);
        createdResult = result;
      }
    } catch (error: unknown) {
      if (!signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        console.error('Error creating message', error);
        setErrorMsg(formatDirectSubmitError(error, 'save'));
      }
    } finally {
      submission.current = null;
      if (mounted.current) setSubmitting(false);
    }

    if (createdResult) {
      try {
        await onCreated?.(createdResult);
      } catch (error) {
        console.error('Error handling created message', error);
      }
    }
  };

  return { onSubmit };
}

export function formatMessageUploadError(
  uppy: Uppy<any, any>,
  file: UppyFile<any, any> | undefined,
): string {
  const target = file?.name?.trim() ? `файл «${file.name.trim()}»` : 'файли';
  const failure = file ? messageUploadFailure(uppy, file.id) : undefined;
  const status = failure?.status ?? file?.response?.status;

  if (status === 401) {
    return `Не вдалося завантажити ${target}: сеанс завершився. Оновіть сторінку та увійдіть знову.`;
  }
  if (status === 403) {
    return `Не вдалося завантажити ${target}: недостатньо прав.`;
  }
  if (status === 404 || status === 409) {
    return `Не вдалося продовжити завантаження ${target}. Видаліть файл, додайте його повторно та спробуйте ще раз.`;
  }
  if (status === 413) {
    return `Не вдалося завантажити ${target}: файл завеликий або змінився після додавання.`;
  }
  if (failure?.message.startsWith('Резервне завантаження')) {
    return `Не вдалося завантажити ${target}. ${failure.message}`;
  }
  if (status) {
    return `Не вдалося завантажити ${target} (HTTP ${status}). Повторіть спробу.`;
  }
  return `Не вдалося завантажити ${target}. Перевірте з’єднання та повторіть спробу.`;
}

function buildAttachmentUpdates(
  existingMedia: InboxMessage['media'],
  fileNames: Record<string, string>,
  replacements: { media_id: string; upload_url: string }[],
  includeExisting: boolean,
  excludedRenameIds: ReadonlySet<string>,
) {
  const replacementIds = new Set(replacements.map((replacement) => replacement.media_id));
  const renames = includeExisting
    ? existingMedia.flatMap((media) => {
        const fileName = fileNames[media.id];
        return fileName &&
          fileName !== media.fileName &&
          !replacementIds.has(media.id) &&
          !excludedRenameIds.has(media.id)
          ? [{ media_id: media.id, file_name: fileName }]
          : [];
      })
    : [];
  return replacements.length || renames.length ? { replacements, renames } : undefined;
}

function optionalInteger(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shortBodyForSubmit(
  data: MessageFormData,
  editTarget: SubmitOptions['editTarget'],
): string | undefined {
  const shortBody = data.text?.trim() || undefined;
  if (!editTarget) return shortBody;

  const originalFullBody = editTarget.message.text?.trim() ?? '';
  const fullBody = data.full_body?.trim() ?? '';
  const originalShortBody =
    (editTarget.message.noHeadersBody?.body ?? editTarget.message.text ?? '').trim() || undefined;
  if (fullBody !== originalFullBody && shortBody === originalShortBody) return undefined;
  return shortBody;
}

function buildRecentValues(
  data: MessageFormData,
  dmrRows: Array<{
    cc?: string | null;
    sender_id?: string | null;
    sender_name?: string | null;
    call_group_id?: string | null;
    call_group_name?: string | null;
    hash_id?: string | null;
  }>,
  cyberEchoEnabled: boolean,
): Partial<RecentValues> {
  return {
    group:
      data.signalGroupMasterKey && data.signalGroupMasterKey !== DO_NOT_SEND_GROUP_VALUE
        ? [data.signalGroupMasterKey]
        : [],
    post: data.post ? [data.post] : [],
    freq: data.freq ? [data.freq] : [],
    unit: data.unit ? [data.unit] : [],
    network_cc: dmrRows.flatMap((metadata) => (metadata.cc ? [metadata.cc] : [])),
    network_signal_name: data.network_signal_name ? [data.network_signal_name] : [],
    network_name: data.network_name ? [data.network_name] : [],
    dmr_sender_id: dmrRows.flatMap((metadata) => (metadata.sender_id ? [metadata.sender_id] : [])),
    dmr_sender_name: dmrRows.flatMap((metadata) =>
      metadata.sender_name ? [metadata.sender_name] : [],
    ),
    dmr_call_group_id: dmrRows.flatMap((metadata) =>
      metadata.call_group_id ? [metadata.call_group_id] : [],
    ),
    dmr_call_group_name: dmrRows.flatMap((metadata) =>
      metadata.call_group_name ? [metadata.call_group_name] : [],
    ),
    dmr_hash_id: dmrRows.flatMap((metadata) => (metadata.hash_id ? [metadata.hash_id] : [])),
    locations: data.locations ?? [],
    callsigns: data.callsigns ?? [],
    deviceName: cyberEchoEnabled ? (data.deviceName ? [data.deviceName] : []) : undefined,
  };
}
