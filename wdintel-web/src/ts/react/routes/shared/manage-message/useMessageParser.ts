import { useCallback, useEffect, useRef, useState } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { parseDirectSubmit } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';
import {
  acceptParsedCandidate,
  clearParserOwnedValues,
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
  const { getValues, setValue, watch } = methods;

  const active = options?.active ?? true;
  const autoParseEnabled = options?.autoParseEnabled ?? false;
  const isEditMode = options?.isEditMode ?? false;
  const isReportMode = options?.isReportMode ?? false;
  const debounceMs = options?.debounceMs ?? DEFAULT_MESSAGE_PARSE_DEBOUNCE_MS;

  const fullBody = watch('full_body');
  const latestRequestIdRef = useRef(0);
  const activeRef = useRef(active);
  const applyingParserPatchRef = useRef(false);
  const feedbackSequenceRef = useRef(0);
  const ownershipRef = useRef(createParserOwnershipState());
  const lastObservedFormRef = useRef(copyFormValues(getValues()));
  if (activeRef.current !== active) {
    activeRef.current = active;
    latestRequestIdRef.current += 1;
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
      emptyCandidateFields: result.emptyCandidateFields,
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
      if (
        name &&
        PARSER_FIELDS.has(name) &&
        !applyingParserPatchRef.current &&
        !isEditMode &&
        !isReportMode
      ) {
        ownershipRef.current = recordManualChange(
          ownershipRef.current,
          name as ParserFieldName,
          currentForm[name as keyof MessageFormData],
          lastObservedFormRef.current,
        );
      }
      lastObservedFormRef.current = currentForm;
    });
    return () => subscription.unsubscribe();
  }, [getValues, isEditMode, isReportMode, watch]);

  const clearParsedValues = useCallback(() => {
    applyParserResult(clearParserOwnedValues(ownershipRef.current, getValues()));
  }, [applyParserResult, getValues]);

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

  const handleParse = useCallback(async () => {
    if (busy) return;
    const currentRawBody = getValues('full_body') ?? '';
    const currentBody = currentRawBody.trim();
    const signalGroupMasterKey = getValues('signalGroupMasterKey')?.trim();
    if (!currentBody) {
      if (!isEditMode && !isReportMode) clearParsedValues();
      setParseStatus('idle');
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
      if (requestId !== latestRequestIdRef.current || !activeRef.current) return;
      lastParsedBodyRef.current = currentRawBody;
      applyParserResult(
        reconcileParserSnapshot(ownershipRef.current, getValues(), toParserSnapshot(parsed)),
      );
      setParseStatus('success');
    } catch (error: any) {
      if (requestId !== latestRequestIdRef.current || !activeRef.current) return;
      lastParsedBodyRef.current = currentRawBody;
      setParseStatus('error');
      console.error('Error parsing message', error);
      setErrorMsg(error.message || 'Не вдалося розпарсити повідомлення');
    } finally {
      if (requestId === latestRequestIdRef.current) setParsing(false);
    }
  }, [
    applyParserResult,
    busy,
    clearParsedValues,
    getValues,
    isEditMode,
    isReportMode,
    setErrorMsg,
  ]);

  const acceptParsedField = useCallback(
    (field: ParserFieldName) => {
      const accepted = acceptParsedCandidate(ownershipRef.current, getValues(), field);
      applyParserResult({
        ...accepted,
        conflictFields: parserFeedback?.conflictFields.filter((item) => item !== field) ?? [],
        emptyCandidateFields:
          parserFeedback?.emptyCandidateFields?.filter((item) => item !== field) ?? [],
      });
    },
    [applyParserResult, getValues, parserFeedback],
  );

  const resetParserSession = useCallback(() => {
    latestRequestIdRef.current += 1;
    ownershipRef.current = createParserOwnershipState();
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
      if (active && !isEditMode && !isReportMode) clearParsedValues();
      return;
    }
    if (parsing) return;
    if (!active || !autoParseEnabled || isEditMode || isReportMode || busy) {
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
    active,
    autoParseEnabled,
    isEditMode,
    isReportMode,
    busy,
    parsing,
    clearParsedValues,
    handleBodyChange,
    handleParse,
    debounceMs,
  ]);

  useEffect(() => {
    if (active) return;
    resetParserSession();
  }, [active, resetParserSession]);

  return {
    parsing,
    parseStatus,
    parserFeedback,
    debounceKey,
    handleBodyChange,
    handleParse,
    acceptParsedField,
    resetParserSession,
  };
}
