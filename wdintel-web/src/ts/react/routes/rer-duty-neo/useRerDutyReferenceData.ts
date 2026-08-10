import { useEffect, useMemo, useRef, useState } from 'react';

import type { Network, Unit } from '../../../../Bindings';
import { getNetworksByIds } from '../../services/api/networks';
import { getUnitsByIds, getUnitsList } from '../../services/api/units';
import { createMasterUnitText } from './utils';
import type { MessageFeedState } from './utils';

export function useRerDutyReferenceData(messageFeeds: MessageFeedState[]) {
  const [networkMap, setNetworkMap] = useState<Record<number, Network>>({});
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});

  const allNetworkIds = useMemo(() => {
    const ids = new Set<number>();
    messageFeeds.forEach((feed) => {
      feed.items.forEach(([, msg]) => {
        (msg.networkIds ?? []).forEach((id) => ids.add(id));
      });
    });
    return Array.from(ids);
  }, [messageFeeds]);

  const networkMapRef = useRef(networkMap);
  networkMapRef.current = networkMap;
  const unitsMapRef = useRef(unitsMap);
  unitsMapRef.current = unitsMap;

  const referencedUnitIds = useMemo(
    () =>
      Array.from(new Set(Object.values(networkMap).flatMap((network) => network.unitIds ?? []))),
    [networkMap],
  );

  useEffect(() => {
    const missing = allNetworkIds.filter((id) => !(id in networkMapRef.current));
    if (missing.length === 0) return;

    let cancelled = false;
    getNetworksByIds(missing)
      .then((networks) => {
        if (cancelled) return;
        setNetworkMap((prev) => {
          const next = { ...prev };
          networks.forEach((network) => {
            next[network.id] = network;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load networks', err));

    return () => {
      cancelled = true;
    };
  }, [allNetworkIds.join(',')]);

  useEffect(() => {
    let cancelled = false;
    getUnitsList()
      .then((units) => {
        if (cancelled) return;
        setUnitsMap((prev) => {
          const next = { ...prev };
          units.forEach((unit) => {
            next[unit.id] = unit;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load units', err));

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const missing = referencedUnitIds.filter((id) => !(id in unitsMapRef.current));
    if (missing.length === 0) return;

    let cancelled = false;
    getUnitsByIds(missing)
      .then((units) => {
        if (cancelled) return;
        setUnitsMap((prev) => {
          const next = { ...prev };
          units.forEach((unit) => {
            next[unit.id] = unit;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load referenced units', err));

    return () => {
      cancelled = true;
    };
  }, [referencedUnitIds.join(',')]);

  const networkDisplayMap = useMemo(() => {
    const next: Record<number, string> = {};
    Object.entries(networkMap).forEach(([idStr, network]) => {
      const id = Number(idStr);
      next[id] = createMasterUnitText(network, unitsMap);
    });
    return next;
  }, [networkMap, unitsMap]);

  return {
    networkDisplayMap,
    networkMap,
    unitsMap,
  };
}
