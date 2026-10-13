import { useEffect, useMemo, useState } from 'react';
import {
  resolveUnitNames,
  searchUnitNames,
  type UnitResponse,
} from '../../../services/api/direct-submit';
import { normalizeMessageUnitName } from './message-unit-name';

const UNIT_SEARCH_DEBOUNCE_MS = 300;

type Props = {
  active: boolean;
  search: string;
  recentNames: string[];
  replaceRecentNames: (names: string[]) => void;
  onError: (description: string, error: unknown) => void;
  retryAttempt: number;
};

export function useMessageUnitOptions({
  active,
  search,
  recentNames,
  replaceRecentNames,
  onError,
  retryAttempt,
}: Props) {
  const [results, setResults] = useState<{
    search: string;
    units: UnitResponse[];
    succeeded: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [recentResults, setRecentResults] = useState<{
    names: string[];
    units: UnitResponse[];
  } | null>(null);

  useEffect(() => {
    if (!active) {
      setResults(null);
      setLoading(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(
      () => {
        searchUnitNames(search, { signal: controller.signal })
          .then((units) => {
            if (current) setResults({ search, units, succeeded: true });
          })
          .catch((error) => {
            if (!current) return;
            setResults({ search, units: [], succeeded: false });
            onError('Failed to load unit names', error);
          })
          .finally(() => {
            if (current) setLoading(false);
          });
      },
      search.trim() ? UNIT_SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
      current = false;
      controller.abort();
    };
  }, [active, onError, retryAttempt, search]);

  useEffect(() => {
    if (!active || recentNames.length === 0) {
      setRecentResults(null);
      return;
    }
    let current = true;
    const controller = new AbortController();
    resolveUnitNames(recentNames, { signal: controller.signal })
      .then((units) => {
        if (!current) return;
        const recentUnits = Array.from(
          new Map(
            recentNames
              .flatMap((name) =>
                units.filter(
                  (unit) => normalizeMessageUnitName(unit.name) === normalizeMessageUnitName(name),
                ),
              )
              .map((unit) => [unit.id, unit]),
          ).values(),
        );
        setRecentResults({ names: recentNames, units: recentUnits });
        replaceRecentNames(Array.from(new Set(recentUnits.map((unit) => unit.name))));
      })
      .catch((error) => {
        if (current) onError('Failed to load recent units', error);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [active, onError, recentNames, replaceRecentNames, retryAttempt]);

  const recentUnitOptions =
    active && recentResults?.names === recentNames ? recentResults.units : [];
  const firstRecentName = recentUnitOptions[0]?.name;
  const firstRecentMatches = recentUnitOptions.filter(
    (unit) =>
      normalizeMessageUnitName(unit.name) === normalizeMessageUnitName(firstRecentName ?? ''),
  );

  const unitOptions = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...recentUnitOptions.filter((unit) =>
              normalizeMessageUnitName(unit.name).includes(normalizeMessageUnitName(search)),
            ),
            ...(results?.search === search ? results.units : []),
          ].map((unit) => [unit.id, unit]),
        ).values(),
      ),
    [recentUnitOptions, results, search],
  );

  return {
    unitOptions,
    unitLoading: active && (loading || results?.search !== search),
    unitAllowCreate: active && results?.search === search && results.succeeded,
    recentUnitOptions,
    defaultRecentUnit: firstRecentMatches.length === 1 ? firstRecentMatches[0] : undefined,
  };
}
