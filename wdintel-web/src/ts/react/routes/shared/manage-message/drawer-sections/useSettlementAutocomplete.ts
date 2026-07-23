import { useCallback, useEffect, useRef, useState } from 'react';
import { findSettlementPrefix, type SettlementDetails } from '../../../../services/api/settlements';
import { HttpRequestError, isAbortError } from '../../../../services/api/client';
import { parseCoordLine } from '../manage-message-drawer.schema';

const MIN_SETTLEMENT_QUERY_LENGTH = 2;
const SETTLEMENT_SEARCH_DEBOUNCE_MS = 300;
const SETTLEMENT_ERROR_MESSAGE = 'Не вдалося завантажити варіанти локацій. Спробуйте ще раз.';

type UseSettlementAutocompleteParams = {
  open: boolean;
  busy: boolean;
  coordsText: string | undefined;
  signalGroupMasterKey: string | null;
  onError: (message: string) => void;
};

type UseSettlementAutocompleteResult = {
  settlementOptions: SettlementDetails[];
  loading: boolean;
  onInputChange: (value: string, reason: string) => void;
};

function relatedCoordinates(coordsText: string | undefined): [number, number] | null {
  const parsed = parseCoordLine(coordsText ?? '');
  return parsed == null ? null : [parsed.lat, parsed.lon];
}

function formatSettlementError(error: unknown): string {
  if (!(error instanceof HttpRequestError)) return SETTLEMENT_ERROR_MESSAGE;
  const detail = error.message.trim();
  if (!detail || detail === 'Internal server error') return SETTLEMENT_ERROR_MESSAGE;
  return `${SETTLEMENT_ERROR_MESSAGE} ${detail}`;
}

export function useSettlementAutocomplete({
  open,
  busy,
  coordsText,
  signalGroupMasterKey,
  onError,
}: UseSettlementAutocompleteParams): UseSettlementAutocompleteResult {
  const [settlementOptions, setSettlementOptions] = useState<SettlementDetails[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const coordsTextRef = useRef(coordsText);
  const signalGroupMasterKeyRef = useRef(signalGroupMasterKey);
  const inputValueRef = useRef('');
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  coordsTextRef.current = coordsText;
  signalGroupMasterKeyRef.current = signalGroupMasterKey;

  const scheduleSearch = useCallback(
    (value: string) => {
      timerRef.current = setTimeout(async () => {
        timerRef.current = null;
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const requestId = requestIdRef.current;
        try {
          const results = await findSettlementPrefix({
            query: value,
            relatedCoordinates: relatedCoordinates(coordsTextRef.current),
            signalGroupMasterKey: signalGroupMasterKeyRef.current,
            signal: controller.signal,
          });
          if (mountedRef.current && requestId === requestIdRef.current) {
            setSettlementOptions(results);
          }
        } catch (error) {
          if (mountedRef.current && requestId === requestIdRef.current && !isAbortError(error)) {
            setSettlementOptions([]);
            onError(formatSettlementError(error));
          }
        } finally {
          if (mountedRef.current && requestId === requestIdRef.current) {
            setLoading(false);
          }
          if (abortControllerRef.current === controller) {
            abortControllerRef.current = null;
          }
        }
      }, SETTLEMENT_SEARCH_DEBOUNCE_MS);
    },
    [onError],
  );

  const cancelSearch = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    requestIdRef.current += 1;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelSearch();
    };
  }, [cancelSearch]);

  useEffect(() => {
    if (open && !busy) return;
    cancelSearch();
    setSettlementOptions([]);
    setLoading(false);
  }, [busy, cancelSearch, open]);

  useEffect(() => {
    if (!open || busy) return;
    cancelSearch();
    setSettlementOptions([]);
    setLoading(false);
    const value = inputValueRef.current;
    if (value.trim().length < MIN_SETTLEMENT_QUERY_LENGTH) return;
    setLoading(true);
    scheduleSearch(value);
  }, [signalGroupMasterKey, busy, cancelSearch, open, scheduleSearch]);

  const onInputChange = useCallback(
    (value: string, reason: string) => {
      if (reason !== 'input') return;
      inputValueRef.current = value;
      cancelSearch();
      const query = value.trim();
      if (!open || busy || query.length < MIN_SETTLEMENT_QUERY_LENGTH) {
        setSettlementOptions([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      scheduleSearch(value);
    },
    [busy, cancelSearch, open, scheduleSearch],
  );

  return { settlementOptions, loading, onInputChange };
}
