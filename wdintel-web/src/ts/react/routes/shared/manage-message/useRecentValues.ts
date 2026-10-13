import { useState, useCallback } from 'react';

const STORAGE_KEY = 'cyberEcho_recentMessageFields';
const MAX_ITEMS = 15;

export type RecentValues = {
  freq: string[];
  post: string[];
  unit: string[];
  locations: string[];
  callsigns: string[];
  network_signal_name: string[];
  network_name: string[];
  network_cc: string[];
  dmr_sender_id: string[];
  dmr_sender_name: string[];
  dmr_call_group_id: string[];
  dmr_call_group_name: string[];
  dmr_hash_id: string[];
  group: string[];
  deviceName: string[];
};

const DEFAULT_VALUES: RecentValues = {
  freq: [],
  post: [],
  unit: [],
  locations: [],
  callsigns: [],
  network_signal_name: [],
  network_name: [],
  network_cc: [],
  dmr_sender_id: [],
  dmr_sender_name: [],
  dmr_call_group_id: [],
  dmr_call_group_name: [],
  dmr_hash_id: [],
  group: [],
  deviceName: [],
};

export function useRecentValues() {
  const [recentValues, setRecentValues] = useState<RecentValues>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return { ...DEFAULT_VALUES, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.error('Failed to load recent values', e);
    }
    return DEFAULT_VALUES;
  });

  const addValues = useCallback((newValues: Partial<RecentValues>) => {
    setRecentValues((prev) => {
      const updated = { ...prev };
      let changed = false;

      (Object.keys(newValues) as Array<keyof RecentValues>).forEach((key) => {
        const valuesToAdd = newValues[key];
        if (!valuesToAdd || valuesToAdd.length === 0) return;

        const currentList = updated[key] || [];
        // Add new values to the front, filter out duplicates and empty strings
        const mergedList = [...valuesToAdd, ...currentList]
          .filter((item, index, arr) => item && item.trim() !== '' && arr.indexOf(item) === index)
          .slice(0, MAX_ITEMS);

        if (JSON.stringify(mergedList) !== JSON.stringify(currentList)) {
          updated[key] = mergedList;
          changed = true;
        }
      });

      if (changed) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        } catch (e) {
          console.error('Failed to save recent values', e);
        }
        return updated;
      }
      return prev;
    });
  }, []);

  const replaceUnitValues = useCallback((unit: string[]) => {
    setRecentValues((prev) => {
      if (JSON.stringify(prev.unit) === JSON.stringify(unit)) return prev;
      const updated = { ...prev, unit };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      } catch (error) {
        console.error('Failed to save recent values', error);
      }
      return updated;
    });
  }, []);

  return { recentValues, addValues, replaceUnitValues };
}
