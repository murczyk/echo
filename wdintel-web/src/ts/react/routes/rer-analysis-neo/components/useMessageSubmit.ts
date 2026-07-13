import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import type { InboxMessage, Tag } from '../../../../../Bindings';
import type Uppy from '@uppy/core';

import {
  searchComputerName,
  createComputerName,
  submitDirect,
} from '../../../services/api/direct-submit';
import { mapFormToInboxMessage } from './create-message-drawer.mappers';
import { parseCoordLine, type MessageFormData } from './create-message-drawer.schema';

type SubmitOptions = {
  busy: boolean;
  isEditMode: boolean;
  editTarget: { id: number; message: InboxMessage } | null | undefined;
  onSubmitEdit: ((id: number, message: InboxMessage) => void | Promise<void>) | undefined;
  tagsMap: Record<number, Tag>;
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
  tagsMap,
  setSubmitting,
  setErrorMsg,
  uppy,
  addValues,
  onSuccess,
  handleDrawerClose,
}: SubmitOptions) {
  const onSubmit = async (data: MessageFormData) => {
    if (busy) return;

    if (isEditMode && editTarget && onSubmitEdit) {
      const labelToTagId = new Map(
        Object.entries(tagsMap).map(([id, tag]) => [tag.label, Number(id)]),
      );
      const merged = mapFormToInboxMessage(
        editTarget.message,
        {
          full_body: data.full_body ?? '',
          comment: data.comment ?? '',
          date: (data.date as Dayjs | null) ?? null,
          time: (data.time as Dayjs | null) ?? null,
          freq: data.freq ?? '',
          coords: data.coords ?? '',
          callsigns: data.callsigns ?? [],
          post: data.post ?? '',
          unit: data.unit ?? '',
          locations: data.locations ?? [],
          tags: data.tags ?? [],
        },
        labelToTagId,
      );
      if (Object.keys(tagsMap).length === 0) {
        merged.tags = editTarget.message.tags;
      }
      await onSubmitEdit(editTarget.id, merged);
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);

    try {
      let computerNameId: number | undefined;
      const computerName = data.computerName?.trim();
      if (computerName) {
        const searchRes = await searchComputerName(computerName);
        if (searchRes) {
          computerNameId = searchRes.id;
        } else {
          const createRes = await createComputerName(computerName);
          computerNameId = createRes.id;
        }
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

        for (const file of uploadResult.successful || []) {
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
        const base = (dateValue ?? dayjs()).startOf('day');
        const merged = timeValue
          ? base.hour(timeValue.hour()).minute(timeValue.minute()).second(timeValue.second())
          : base;
        timestamp = merged.toISOString();
      }

      let networkObj: any = undefined;
      if (data.network_signal_name || data.network_cc || data.network_name) {
        networkObj = {
          signal_name: data.network_signal_name || undefined,
          cc: data.network_cc ? parseInt(data.network_cc, 10) : undefined,
          name: data.network_name || undefined,
        };
      }

      let dmrArr: any[] | undefined = undefined;
      const isDmr = !!(
        data.network_signal_name?.trim().toLowerCase() === 'dmr' ||
        data.dmr_sender_id?.trim() ||
        data.dmr_sender_name?.trim() ||
        data.dmr_call_group_id?.trim() ||
        data.dmr_call_group_name?.trim() ||
        data.dmr_hash_id?.trim()
      );
      if (isDmr && data.freq) {
        dmrArr = [
          {
            timestamp: timestamp || new Date().toISOString(),
            freq: data.freq,
            signal_name: 'DMR',
            cc: data.network_cc ? parseInt(data.network_cc, 10) : undefined,
            sender_id: data.dmr_sender_id ? parseInt(data.dmr_sender_id, 10) : undefined,
            sender_name: data.dmr_sender_name || undefined,
            call_group_id: data.dmr_call_group_id
              ? parseInt(data.dmr_call_group_id, 10)
              : undefined,
            call_group_name: data.dmr_call_group_name || undefined,
            hash_id: data.dmr_hash_id || undefined,
          },
        ];
      }

      await submitDirect({
        full_body: data.full_body?.trim() || undefined,
        text: data.text?.trim() || undefined,
        comment: data.comment?.trim() || undefined,
        signal_group_master_key: data.signalGroupMasterKey,
        device_name_id: computerNameId,
        upload_urls: uploadUrls.length > 0 ? uploadUrls : null,
        freq: data.freq || undefined,
        coords: coordsResult,
        to: data.callsigns || [],
        tags: data.tags || [],
        timestamp,
        post: data.post || undefined,
        unit: data.unit || undefined,
        locations: data.locations || [],
        network: networkObj,
        dmr: dmrArr,
      });

      addValues({
        freq: data.freq ? [data.freq] : [],
        post: data.post ? [data.post] : [],
        unit: data.unit ? [data.unit] : [],
        network_cc: data.network_cc ? [data.network_cc] : [],
        network_signal_name: data.network_signal_name ? [data.network_signal_name] : [],
        network_name: data.network_name ? [data.network_name] : [],
        dmr_sender_id: data.dmr_sender_id ? [data.dmr_sender_id] : [],
        dmr_sender_name: data.dmr_sender_name ? [data.dmr_sender_name] : [],
        dmr_call_group_id: data.dmr_call_group_id ? [data.dmr_call_group_id] : [],
        dmr_call_group_name: data.dmr_call_group_name ? [data.dmr_call_group_name] : [],
        dmr_hash_id: data.dmr_hash_id ? [data.dmr_hash_id] : [],
        locations: data.locations ?? [],
        callsigns: data.callsigns ?? [],
      });

      onSuccess?.();
      handleDrawerClose();
    } catch (e: any) {
      console.error('Error creating message', e);
      setErrorMsg(e.message || 'Сталася невідома помилка');
    } finally {
      setSubmitting(false);
    }
  };

  return { onSubmit };
}
