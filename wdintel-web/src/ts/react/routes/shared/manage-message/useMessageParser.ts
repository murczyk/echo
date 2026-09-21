import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import dayjs from 'dayjs';

import { parseDirectSubmit } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';

export type UseMessageParserOptions = {
  autoParseEnabled?: boolean;
  isEditMode?: boolean;
  isReportMode?: boolean;
  debounceMs?: number;
};

export function useMessageParser(
  methods: UseFormReturn<MessageFormData>,
  busy: boolean,
  setErrorMsg: (msg: string | null) => void,
  options?: UseMessageParserOptions,
) {
  const [parsing, setParsing] = useState(false);
  const [parseSuccess, setParseSuccess] = useState(false);
  const [parseError, setParseError] = useState(false);
  const { getValues, setValue, watch } = methods;

  const autoParseEnabled = options?.autoParseEnabled ?? false;
  const isEditMode = options?.isEditMode ?? false;
  const isReportMode = options?.isReportMode ?? false;
  const debounceMs = options?.debounceMs ?? 1000;

  const fullBody = watch('full_body');
  const lastParsedBodyRef = useRef<string | null>(null);

  const handleParse = useCallback(
    async (opts?: { isAuto?: boolean }) => {
      if (parsing || busy) return;
      const currentBody = getValues('full_body')?.trim();
      const signalGroupMasterKey = getValues('signalGroupMasterKey')?.trim();
      if (!currentBody) {
        if (!opts?.isAuto) {
          setErrorMsg('Введіть текст повідомлення');
        }
        return;
      }

      setParseSuccess(false);
      setParseError(false);
      setParsing(true);
      setErrorMsg(null);
      try {
        const parsed = await parseDirectSubmit({
          full_body: currentBody,
          ...(signalGroupMasterKey ? { signal_group_master_key: signalGroupMasterKey } : {}),
        });
        lastParsedBodyRef.current = currentBody;
        setParseSuccess(true);
        const timestamp = parsed.timestamp ? dayjs(parsed.timestamp) : null;
        const fillText = (
          name: 'text' | 'freq' | 'coords' | 'comment' | 'post' | 'unit' | 'network_name',
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
          parsed.coords
            ?.map(({ lat, lon }) => `${Number(lat.toFixed(5))}, ${Number(lon.toFixed(5))}`)
            .join('\n') ?? '',
        );
        fillText('comment', parsed.comment ?? '');
        fillText('post', parsed.post ?? '');
        fillText('network_name', parsed.unit ?? '');
        fillText('unit', parsed.unit_v2 ?? '');
        fillList('callsigns', parsed.to);
        fillList('locations', parsed.locations);
        if (timestamp?.isValid()) {
          setValue('date', timestamp, { shouldDirty: true });
          if (parsed.is_time_null === true) {
            setValue('time', null, { shouldDirty: true });
          } else {
            setValue('time', timestamp, { shouldDirty: true });
          }
        }
      } catch (error: any) {
        lastParsedBodyRef.current = currentBody;
        setParseError(true);
        console.error('Error parsing message', error);
        setErrorMsg(error.message || 'Не вдалося розпарсити повідомлення');
      } finally {
        setParsing(false);
      }
    },
    [busy, getValues, parsing, setErrorMsg, setValue],
  );

  useEffect(() => {
    const trimmed = fullBody?.trim();
    if (!trimmed) {
      lastParsedBodyRef.current = null;
      setParseSuccess(false);
      setParseError(false);
      return;
    }
    if (trimmed !== lastParsedBodyRef.current) {
      setParseSuccess(false);
      setParseError(false);
    }
    if (!autoParseEnabled || isEditMode || isReportMode || busy || parsing) {
      return;
    }
    if (trimmed === lastParsedBodyRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      void handleParse({ isAuto: true });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [
    fullBody,
    autoParseEnabled,
    isEditMode,
    isReportMode,
    busy,
    parsing,
    handleParse,
    debounceMs,
  ]);

  return {
    parsing,
    parseSuccess,
    parseError,
    handleParse,
  };
}
