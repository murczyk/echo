import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DailyMessageStatsFacetRsp,
  DailyMessageStatsPanelsRsp,
  DailyMessageStatsSendersRsp,
  DailyMessageStatsSenderLabel,
  UnitHierarchyRsp,
} from '../../../../Bindings';
import type { GroupNavigationItem } from '../shared/group-navigation';
import { fetchDailyMessageStatsCatalog } from '../../services/api/daily-message-stats';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import { senderValue, STATS_REFRESH_MS, type StatsState } from './state';
import { StatsResourceCache } from './use-stats-resource';

export function useStatsCatalog(state: StatsState) {
  const [groups, setGroups] = useState<GroupNavigationItem[]>([]);
  const [hierarchy, setHierarchy] = useState<UnitHierarchyRsp | null>(null);
  const [senderLabels, setSenderLabels] = useState(new Map<string, string>());
  const [accessRevision, setAccessRevision] = useState<string | null>(null);
  const [scopeVersion, setScopeVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [revision, setRevision] = useState(0);
  const cache = useRef(new StatsResourceCache()).current;
  const access = useRef<string | null>(null);
  const tree = useRef<UnitHierarchyRsp | null>(null);
  const labels = useRef(new Map<string, string>());
  const loadedRevision = useRef(-1);
  const pending = useRef(false);
  const loadedAt = useRef(0);
  const selectedKey = JSON.stringify(state.senders);
  const { notify } = usePowerSnackbar();
  const rememberSenders = useCallback(
    (entries: DailyMessageStatsSenderLabel[], responseRevision: string) => {
      if (responseRevision !== access.current) return;
      entries.forEach((entry) => labels.current.set(senderValue(entry.key), entry.label));
      setSenderLabels(new Map(labels.current));
    },
    [],
  );
  const clearAccess = useCallback(() => {
    cache.clear();
    labels.current.clear();
    setSenderLabels(new Map());
    access.current = null;
    setAccessRevision(null);
    setGroups([]);
    loadedRevision.current = -1;
    setScopeVersion((value) => value + 1);
  }, [cache]);
  const reject = useCallback(
    (reason: unknown) => {
      if (!(reason instanceof HttpRequestError) || ![401, 403].includes(reason.status)) return;
      clearAccess();
      tree.current = null;
      setHierarchy(null);
      setDenied(true);
      setLoading(false);
      setError(reason.message);
    },
    [clearAccess],
  );
  const checkResponse = useCallback(
    (
      response:
        DailyMessageStatsFacetRsp | DailyMessageStatsSendersRsp | DailyMessageStatsPanelsRsp,
    ) => {
      if (!access.current) return false;
      if (response.accessRevision !== access.current) {
        clearAccess();
        setRevision((value) => value + 1);
        return false;
      }
      if (
        'hierarchyRevision' in response &&
        response.hierarchyRevision &&
        response.hierarchyRevision !== tree.current?.revision
      ) {
        setRevision((value) => value + 1);
        return false;
      }
      return true;
    },
    [clearAccess],
  );
  useEffect(() => {
    if (denied) return;
    const selected = JSON.parse(selectedKey) as string[];
    if (loadedRevision.current === revision && !selected.some((key) => !labels.current.has(key)))
      return;
    const controller = new AbortController();
    pending.current = true;
    setLoading(true);
    fetchDailyMessageStatsCatalog(
      {
        knownHierarchyRevision: tree.current?.revision ?? null,
        selectedSenders: selected.map((key) => ({ sender: JSON.parse(key) as string | null })),
      },
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (access.current && access.current !== response.accessRevision) clearAccess();
        access.current = response.accessRevision;
        setAccessRevision(response.accessRevision);
        if (response.unitHierarchy) {
          tree.current = response.unitHierarchy;
          setHierarchy(response.unitHierarchy);
        }
        setGroups([
          { kind: 'all', masterKey: null, name: 'Всі групи' },
          ...response.groups.map((group) => ({
            kind: 'group' as const,
            masterKey: group.key,
            name: group.label,
            colorKey: 'blue_grey' as const,
          })),
        ]);
        rememberSenders(response.senderLabels, response.accessRevision);
        loadedRevision.current = revision;
        loadedAt.current = Date.now();
        setError(null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isAbortError(reason)) return;
        reject(reason);
        const message =
          reason instanceof Error ? reason.message : 'Не вдалося завантажити фільтри.';
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          pending.current = false;
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      pending.current = false;
    };
  }, [selectedKey, revision, denied, notify, clearAccess, reject, rememberSenders]);
  useEffect(() => {
    if (denied) return;
    const refresh = () => {
      if (
        document.visibilityState === 'visible' &&
        !pending.current &&
        Date.now() - loadedAt.current >= STATS_REFRESH_MS
      )
        setRevision((value) => value + 1);
    };
    const timer = window.setInterval(refresh, STATS_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [denied]);
  return {
    groups,
    hierarchy,
    senderLabels,
    accessRevision,
    scopeVersion,
    error,
    loading,
    denied,
    cache,
    checkResponse,
    rememberSenders,
    reject,
    retry: () => {
      setDenied(false);
      setRevision((value) => value + 1);
    },
  };
}
