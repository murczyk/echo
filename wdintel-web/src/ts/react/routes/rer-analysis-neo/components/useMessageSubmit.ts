import type { Dayjs } from 'dayjs';
import type { InboxMessage } from '../../../../../Bindings';
import type Uppy from '@uppy/core';

import {
  createComputerName,
  submitDirect,
  editDirectSubmit,
  formatDirectSubmitError,
} from '../../../services/api/direct-submit';
import { parseCoordLine, type MessageFormData } from './manage-message-drawer.schema';
import { combineDateTimeToMs, formatDateInputValueInTimeZone } from '../../../utils/misc';

type SubmitOptions = {
  busy: boolean;
  isEditMode: boolean;
  editTarget: { id: number; message: InboxMessage } | null | undefined;
  onSubmitEdit: ((id: number, message: InboxMessage) => void | Promise<void>) | undefined;
  tagsLoaded: boolean;
  setSubmitting: (val: boolean) => void;
  setErrorMsg: (msg: string | null) => void;
  uppy: Uppy<any, any>;
  addValues: (vals: any) => void;
  onSuccess?: () => void;
  handleDrawerClose: () => void;
};

export function useMessageSubmit({
  busy,
  isEditMode,
  editTarget,
  onSubmitEdit,
  tagsLoaded,
  setSubmitting,
  setErrorMsg,
  uppy,
  addValues,
  onSuccess,
  handleDrawerClose,
}: SubmitOptions) {
  const onSubmit = async (data: MessageFormData) => {
    if (busy) return;

    const hasTextContent = !!(data.text?.trim() || data.full_body?.trim());
    const uppyFiles = uppy.getFiles();
    const hasNewFiles = uppyFiles.length > 0;

    // In edit mode, check if there are existing media files that are not deleted
    const deletedMediaIds = new Set(data.deleted_media_ids ?? []);
    const hasExistingMedia = Boolean(
      isEditMode && editTarget?.message.media.some((media) => !deletedMediaIds.has(media.id)),
    );

    if (!hasTextContent && !hasNewFiles && !hasExistingMedia) {
      setErrorMsg("Текст повідомлення або вкладення є обов'язковими");
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      let computerNameId: number | undefined;
      const computerName = data.computerName?.trim();
      if (computerName) {
        const device = await createComputerName(computerName);
        computerNameId = device.id;
      }

      const files = uppy.getFiles();
      const uploadUrls: string[] = [];

      if (files.length > 0) {
        const uploadResult = await uppy.upload();
        if (!uploadResult) {
          throw new Error('Помилка завантаження файлів (no result)');
        }
        if ((uploadResult.failed || []).length > 0) {
          throw new Error('Помилка завантаження файлів');
        }

        for (const file of uppy.getFiles()) {
          const url = file.tus?.uploadUrl || file.uploadURL || file.response?.uploadURL;
          if (url) {
            uploadUrls.push(url);
          } else {
            throw new Error(`Помилка: не знайдено URL для файлу ${file.name}`);
          }
        }
      }

      const coordsResult: { lat: number; lon: number }[] = [];
      if (data.coords && data.coords.trim()) {
        const coord = parseCoordLine(data.coords);
        if (coord) coordsResult.push(coord);
      }

      const dateValue = data.date as Dayjs | null;
      const timeValue = data.time as Dayjs | null;
      let timestamp: string | undefined;
      if (dateValue || timeValue) {
        const date = dateValue?.format('YYYY-MM-DD') ?? formatDateInputValueInTimeZone(new Date());
        const time = timeValue?.format('HH:mm') ?? '00:00';
        const timestampMs = combineDateTimeToMs(date, time);
        if (timestampMs != null) timestamp = new Date(timestampMs).toISOString();
      }

      const dmrRows = (data.dmr ?? []).filter((metadata) =>
        Object.values(metadata).some((value) => value?.trim()),
      );
      const primaryCc = optionalInteger(dmrRows[0]?.cc);
      const networkSignalName = data.network_signal_name?.trim() || undefined;
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

      const payload = {
        full_body: data.full_body?.trim() || undefined,
        text: data.text?.trim() || undefined,
        comment: data.comment?.trim() || undefined,
        signal_group_master_key: data.signalGroupMasterKey,
        device_name_id: computerNameId,
        upload_urls: uploadUrls.length > 0 ? uploadUrls : null,
        freq: data.freq || undefined,
        coords: coordsResult,
        to: data.callsigns || [],
        tags: isEditMode && !tagsLoaded ? undefined : (data.tags ?? []),
        timestamp,
        post: data.post || undefined,
        unit: data.unit || undefined,
        locations: data.locations || [],
        network: networkObj,
        dmr: dmrArr,
        deleted_media_ids: data.deleted_media_ids || [],
      };

      if (isEditMode && editTarget) {
        const res = await editDirectSubmit(editTarget.id, payload);
        if (onSubmitEdit && res.message) {
          await onSubmitEdit(editTarget.id, res.message);
        }
      } else {
        await submitDirect(payload);
      }

      addValues({
        group: data.signalGroupMasterKey ? [data.signalGroupMasterKey] : [],
        post: data.post ? [data.post] : [],
        freq: data.freq ? [data.freq] : [],
        unit: data.unit ? [data.unit] : [],
        network_cc: dmrRows.flatMap((metadata) => (metadata.cc ? [metadata.cc] : [])),
        network_signal_name: data.network_signal_name ? [data.network_signal_name] : [],
        network_name: data.network_name ? [data.network_name] : [],
        dmr_sender_id: dmrRows.flatMap((metadata) =>
          metadata.sender_id ? [metadata.sender_id] : [],
        ),
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
      });

      onSuccess?.();
      handleDrawerClose();
    } catch (error: unknown) {
      console.error('Error creating message', error);
      setErrorMsg(formatDirectSubmitError(error, 'save'));
    } finally {
      setSubmitting(false);
    }
  };

  return { onSubmit };
}

function optionalInteger(value: string | null | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
