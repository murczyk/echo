import { useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import dayjs from 'dayjs';

import { parseDirectSubmit } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';

export function useMessageParser(
  methods: UseFormReturn<MessageFormData>,
  busy: boolean,
  setErrorMsg: (msg: string | null) => void,
) {
  const [parsing, setParsing] = useState(false);
  const { getValues, setValue } = methods;

  const handleParse = async () => {
    if (parsing || busy) return;
    const fullBody = getValues('full_body')?.trim();
    const signalGroupMasterKey = getValues('signalGroupMasterKey')?.trim();
    if (!fullBody) {
      setErrorMsg('Введіть текст повідомлення');
      return;
    }

    setParsing(true);
    setErrorMsg(null);
    try {
      const parsed = await parseDirectSubmit({
        full_body: fullBody,
        ...(signalGroupMasterKey ? { signal_group_master_key: signalGroupMasterKey } : {}),
      });
      const timestamp = parsed.timestamp ? dayjs(parsed.timestamp) : null;
      const fillText = (
        name: 'text' | 'freq' | 'coords' | 'comment' | 'post' | 'unit',
        value: string | null | undefined,
      ) => {
        if (!value) return;
        setValue(name, value, { shouldDirty: true, shouldValidate: true });
      };
      const fillList = (name: 'callsigns' | 'locations', value: string[] | undefined) => {
        if (!value || value.length === 0) return;
        setValue(name, value, { shouldDirty: true, shouldValidate: true });
      };
      fillText('text', parsed.text);
      fillText('freq', parsed.freq ?? '');
      fillText(
        'coords',
        parsed.coords && parsed.coords[0] ? `${parsed.coords[0].lat}, ${parsed.coords[0].lon}` : '',
      );
      fillText('comment', parsed.comment ?? '');
      fillText('post', parsed.post ?? '');
      fillText('unit', parsed.unit ?? '');
      fillList('callsigns', parsed.to);
      fillList('locations', parsed.locations);
      if (timestamp?.isValid()) {
        setValue('date', timestamp, { shouldDirty: true });
        setValue('time', timestamp, { shouldDirty: true });
      }
    } catch (error: any) {
      console.error('Error parsing message', error);
      setErrorMsg(error.message || 'Не вдалося розпарсити повідомлення');
    } finally {
      setParsing(false);
    }
  };

  return {
    parsing,
    handleParse,
  };
}
