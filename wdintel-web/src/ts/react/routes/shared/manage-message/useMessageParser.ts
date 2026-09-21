import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import dayjs from 'dayjs';

import { parseDirectSubmit } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';

export type UseMessageParserOptions = {
  active?: boolean;
  autoParseEnabled?: boolean;
  isEditMode?: boolean;
  isReportMode?: boolean;
  debounceMs?: number;
};

export type MessageParseStatus = 'idle' | 'debouncing' | 'parsing' | 'success' | 'error';
export const DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS = 1000;

export function useMessageParser(
  methods: UseFormReturn<MessageFormData>,
  busy: boolean,
  setErrorMsg: (msg: string | null) => void,
  options?: UseMessageParserOptions,
) {
  const [parsing, setParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState<MessageParseStatus>('idle');
  const [debounceKey, setDebounceKey] = useState(0);
  const [bodyRevision, setBodyRevision] = useState(0);
  const { getValues, setValue, watch } = methods;

  const active = options?.active ?? true;
  const autoParseEnabled = options?.autoParseEnabled ?? false;
  const isEditMode = options?.isEditMode ?? false;
  const isReportMode = options?.isReportMode ?? false;
  const debounceMs = options?.debounceMs ?? DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS;

  const fullBody = watch('full_body');
  const latestRequestIdRef = useRef(0);
  const activeRef = useRef(active);
  if (activeRef.current !== active) {
    activeRef.current = active;
    latestRequestIdRef.current += 1;
  }
  const observedBodyRef = useRef(fullBody ?? '');
  const lastParsedBodyRef = useRef<string | null>(null);

  const handleBodyChange = useCallback(
    (rawBody: string) => {
      if (rawBody === observedBodyRef.current) return false;

      observedBodyRef.current = rawBody;
      latestRequestIdRef.current += 1;
      lastParsedBodyRef.current = null;
      setBodyRevision((revision) => revision + 1);
      setParsing(false);

      if (!rawBody.trim()) {
        setParseStatus('idle');
      } else if (active && autoParseEnabled && !isEditMode && !isReportMode && !busy) {
        setParseStatus('debouncing');
      } else {
        setParseStatus('idle');
      }

      return true;
    },
    [active, autoParseEnabled, busy, isEditMode, isReportMode],
  );

  const handleParse = useCallback(
    async (opts?: { isAuto?: boolean }) => {
      if (busy) return;
      const currentRawBody = getValues('full_body') ?? '';
      const currentBody = currentRawBody.trim();
      const signalGroupMasterKey = getValues('signalGroupMasterKey')?.trim();
      if (!currentBody) {
        if (!opts?.isAuto) {
          setErrorMsg('Введіть текст повідомлення');
        }
        return;
      }

      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;
      setParseStatus('parsing');
      setParsing(true);
      setErrorMsg(null);
      try {
        const parsed = await parseDirectSubmit({
          full_body: currentBody,
          ...(signalGroupMasterKey ? { signal_group_master_key: signalGroupMasterKey } : {}),
        });
        if (requestId !== latestRequestIdRef.current || !activeRef.current) {
          return;
        }
        lastParsedBodyRef.current = currentRawBody;
        setParseStatus('success');
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
        if (requestId !== latestRequestIdRef.current || !activeRef.current) {
          return;
        }
        lastParsedBodyRef.current = currentRawBody;
        setParseStatus('error');
        console.error('Error parsing message', error);
        setErrorMsg(error.message || 'Не вдалося розпарсити повідомлення');
      } finally {
        if (requestId === latestRequestIdRef.current) {
          setParsing(false);
        }
      }
    },
    [busy, getValues, setErrorMsg, setValue],
  );

  useEffect(() => {
    const rawBody = fullBody ?? '';
    if (handleBodyChange(rawBody)) return;

    const trimmed = rawBody.trim();
    if (!trimmed) {
      lastParsedBodyRef.current = null;
      setParseStatus('idle');
      return;
    }
    if (parsing) return;
    if (!active || !autoParseEnabled || isEditMode || isReportMode || busy) {
      if (rawBody !== lastParsedBodyRef.current) {
        setParseStatus('idle');
      }
      return;
    }
    if (rawBody === lastParsedBodyRef.current) {
      return;
    }

    setParseStatus('debouncing');
    setDebounceKey((key) => key + 1);
    const timer = setTimeout(() => {
      void handleParse({ isAuto: true });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [
    fullBody,
    bodyRevision,
    active,
    autoParseEnabled,
    isEditMode,
    isReportMode,
    busy,
    parsing,
    handleBodyChange,
    handleParse,
    debounceMs,
  ]);

  useEffect(() => {
    if (active) return;
    setParsing(false);
    setParseStatus('idle');
    lastParsedBodyRef.current = null;
  }, [active]);

  return {
    parsing,
    parseStatus,
    debounceKey,
    handleBodyChange,
    handleParse,
  };
}
