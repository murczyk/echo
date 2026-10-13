import { useEffect, useMemo, useState } from 'react';
import {
  resolveUnitNames,
  searchUnitNames,
  type UnitResponse,
} from '../../../services/api/direct-submit';

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
  const [results, setResults] = useState<{ search: string; units: UnitResponse[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [recentUnitOptions, setRecentUnitOptions] = useState<UnitResponse[]>([]);

  useEffect(() => {
    if (!active) {
      setResults(null);
      setLoading(false);
      return;
    }
    let current = true;
    const controller = new AbortController();
    setLoading(true);
    searchUnitNames(search, { signal: controller.signal })
      .then((units) => {
        if (current) setResults({ search, units });
      })
      .catch((error) => {
        if (!current) return;
        setResults({ search, units: [] });
        onError('Failed to load unit names', error);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [active, onError, retryAttempt, search]);

  useEffect(() => {
    if (!active || recentNames.length === 0) {
      setRecentUnitOptions([]);
      return;
    }
    let current = true;
    const controller = new AbortController();
    resolveUnitNames(recentNames, { signal: controller.signal })
      .then((units) => {
        if (!current) return;
        const recentUnits = recentNames.flatMap((name) =>
          units.filter((unit) => unit.name.trim().toLowerCase() === name.trim().toLowerCase()),
        );
        setRecentUnitOptions(recentUnits);
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

  const unitOptions = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...recentUnitOptions.filter((unit) =>
              unit.name.toLowerCase().includes(search.trim().toLowerCase()),
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
    recentUnitOptions,
  };
}
