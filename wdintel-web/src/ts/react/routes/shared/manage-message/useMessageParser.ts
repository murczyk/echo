import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { parseDirectSubmit } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';
import {
  acceptParsedCandidate,
  createParserOwnershipState,
  PARSER_LIST_FIELDS,
  PARSER_SCALAR_FIELDS,
  reconcileParserSnapshot,
  recordManualChange,
  toParserSnapshot,
  type ParserFeedback,
  type ParserFieldName,
  type ParserReconcileResult,
} from './message-parser-ownership';

export type UseMessageParserOptions = {
  active?: boolean;
  autoParseEnabled?: boolean;
  isEditMode?: boolean;
  isReportMode?: boolean;
  debounceMs?: number;
  onPristineSourceCleared?: () => void;
};

export type MessageParseStatus = 'idle' | 'debouncing' | 'parsing' | 'success' | 'error';
export const DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS = 700;
export const MESSAGE_PARSE_FEEDBACK_MS = 3000;

const PARSER_FIELDS = new Set<string>([...PARSER_SCALAR_FIELDS, ...PARSER_LIST_FIELDS]);

function copyFormValues(values: MessageFormData): MessageFormData {
  return {
    ...values,
    callsigns: [...(values.callsigns ?? [])],
    locations: [...(values.locations ?? [])],
  };
}

export function useMessageParser(
  methods: UseFormReturn<MessageFormData>,
  busy: boolean,
  setErrorMsg: (msg: string | null) => void,
  options?: UseMessageParserOptions,
) {
  const [parsing, setParsing] = useState(false);
  const [parseStatus, setParseStatus] = useState<MessageParseStatus>('idle');
  const [parserFeedback, setParserFeedback] = useState<ParserFeedback | null>(null);
  const [debounceKey, setDebounceKey] = useState(0);
  const [bodyRevision, setBodyRevision] = useState(0);
  const { getFieldState, getValues, setValue, watch } = methods;

  const active = options?.active ?? true;
  const autoParseEnabled = options?.autoParseEnabled ?? false;
  const isEditMode = options?.isEditMode ?? false;
  const isReportMode = options?.isReportMode ?? false;
  const parserActive = active && !isEditMode && !isReportMode;
  const debounceMs = options?.debounceMs ?? DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS;
  const onPristineSourceCleared = options?.onPristineSourceCleared;

  const fullBody = watch('full_body');
  const latestRequestIdRef = useRef(0);
  const parserActiveRef = useRef(parserActive);
  const parseInFlightRef = useRef(false);
  const applyingParserPatchRef = useRef(false);
  const hasManualFormChangesRef = useRef(false);
  const feedbackSequenceRef = useRef(0);
  const ownershipRef = useRef(createParserOwnershipState());
  const lastObservedFormRef = useRef(copyFormValues(getValues()));
  if (parserActiveRef.current !== parserActive) {
    parserActiveRef.current = parserActive;
    latestRequestIdRef.current += 1;
    parseInFlightRef.current = false;
  }
  const observedBodyRef = useRef(fullBody ?? '');
  const lastParsedBodyRef = useRef<string | null>(null);

  const publishFeedback = useCallback((result: ParserReconcileResult) => {
    if (result.changedFields.length === 0 && result.conflictFields.length === 0) {
      setParserFeedback(null);
      return;
    }
    feedbackSequenceRef.current += 1;
    setParserFeedback({
      sequence: feedbackSequenceRef.current,
      changedFields: result.changedFields,
      conflictFields: result.conflictFields,
    });
  }, []);

  const applyParserResult = useCallback(
    (result: ParserReconcileResult) => {
      ownershipRef.current = result.state;
      applyingParserPatchRef.current = true;
      try {
        for (const [field, value] of Object.entries(result.patch)) {
          setValue(field as keyof MessageFormData, value, {
            shouldDirty: true,
            shouldValidate: true,
          });
        }
      } finally {
        applyingParserPatchRef.current = false;
        lastObservedFormRef.current = copyFormValues(getValues());
      }
      publishFeedback(result);
    },
    [getValues, publishFeedback, setValue],
  );

  useEffect(() => {
    const subscription = watch((_values, { name }) => {
      const currentForm = copyFormValues(getValues());
      if (name && !applyingParserPatchRef.current && !isEditMode && !isReportMode) {
        if (PARSER_FIELDS.has(name)) {
          hasManualFormChangesRef.current = true;
          ownershipRef.current = recordManualChange(
            ownershipRef.current,
            name as ParserFieldName,
            currentForm[name as keyof MessageFormData],
            lastObservedFormRef.current,
          );
        } else if (name !== 'full_body' && getFieldState(name as keyof MessageFormData).isDirty) {
          hasManualFormChangesRef.current = true;
        }
      }
      lastObservedFormRef.current = currentForm;
    });
    return () => subscription.unsubscribe();
  }, [getFieldState, getValues, isEditMode, isReportMode, watch]);

  const handleBodyChange = useCallback(
    (rawBody: string) => {
      if (rawBody === observedBodyRef.current) return false;

      const sourceWasNotEmpty = Boolean(observedBodyRef.current.trim());
      observedBodyRef.current = rawBody;
      latestRequestIdRef.current += 1;
      parseInFlightRef.current = false;
      lastParsedBodyRef.current = null;
      setBodyRevision((revision) => revision + 1);
      setParsing(false);

      if (!rawBody.trim()) {
        if (sourceWasNotEmpty && !hasManualFormChangesRef.current) {
          ownershipRef.current = createParserOwnershipState();
          setParserFeedback(null);
          onPristineSourceCleared?.();
          lastObservedFormRef.current = copyFormValues(getValues());
        }
        setParseStatus('idle');
      } else if (parserActive && autoParseEnabled && !busy) {
        setParseStatus('debouncing');
      } else {
        setParseStatus('idle');
      }

      return true;
    },
    [autoParseEnabled, busy, getValues, onPristineSourceCleared, parserActive],
  );

  const handleParse = useCallback(async () => {
    if (busy || parseInFlightRef.current || !parserActiveRef.current) return;
    const currentRawBody = getValues('full_body') ?? '';
    const currentBody = currentRawBody.trim();
    const signalGroupMasterKey = getValues('signalGroupMasterKey')?.trim();
    if (!currentBody) {
      setParseStatus('idle');
      return;
    }

    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    parseInFlightRef.current = true;
    setParseStatus('parsing');
    setParsing(true);
    setErrorMsg(null);
    try {
      const parsed = await parseDirectSubmit({
        full_body: currentBody,
        ...(signalGroupMasterKey ? { signal_group_master_key: signalGroupMasterKey } : {}),
      });
      if (requestId !== latestRequestIdRef.current || !parserActiveRef.current) return;
      lastParsedBodyRef.current = currentRawBody;
      applyParserResult(
        reconcileParserSnapshot(ownershipRef.current, getValues(), toParserSnapshot(parsed)),
      );
      setParseStatus('success');
    } catch (error: any) {
      if (requestId !== latestRequestIdRef.current || !parserActiveRef.current) return;
      lastParsedBodyRef.current = currentRawBody;
      setParseStatus('error');
      console.error('Error parsing message', error);
      setErrorMsg(error.message || 'Не вдалося розпарсити повідомлення');
    } finally {
      if (requestId === latestRequestIdRef.current) {
        parseInFlightRef.current = false;
        setParsing(false);
      }
    }
  }, [applyParserResult, busy, getValues, setErrorMsg]);

  const acceptParsedField = useCallback(
    (field: ParserFieldName) => {
      const accepted = acceptParsedCandidate(ownershipRef.current, getValues(), field);
      applyParserResult({
        ...accepted,
        conflictFields: parserFeedback?.conflictFields.filter((item) => item !== field) ?? [],
      });
    },
    [applyParserResult, getValues, parserFeedback],
  );

  const resetParserState = useCallback(() => {
    latestRequestIdRef.current += 1;
    parseInFlightRef.current = false;
    ownershipRef.current = createParserOwnershipState();
    hasManualFormChangesRef.current = false;
    observedBodyRef.current = getValues('full_body') ?? '';
    lastObservedFormRef.current = copyFormValues(getValues());
    lastParsedBodyRef.current = null;
    setParsing(false);
    setParseStatus('idle');
    setParserFeedback(null);
  }, [getValues]);

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
    if (!parserActive || !autoParseEnabled || busy) {
      if (rawBody !== lastParsedBodyRef.current) setParseStatus('idle');
      return;
    }
    if (rawBody === lastParsedBodyRef.current) return;

    setParseStatus('debouncing');
    setDebounceKey((key) => key + 1);
    const timer = window.setTimeout(() => {
      void handleParse();
    }, debounceMs);

    return () => window.clearTimeout(timer);
  }, [
    fullBody,
    bodyRevision,
    parserActive,
    autoParseEnabled,
    busy,
    parsing,
    handleBodyChange,
    handleParse,
    debounceMs,
  ]);

  useEffect(() => {
    if (parserActive) return;
    resetParserState();
  }, [parserActive, resetParserState]);

  return {
    parsing,
    parseStatus,
    parserFeedback,
    debounceKey,
    handleBodyChange,
    handleParse,
    acceptParsedField,
  };
}
