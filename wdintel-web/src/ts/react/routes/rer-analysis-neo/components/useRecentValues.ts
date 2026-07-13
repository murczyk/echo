import { useState, useEffect, useCallback } from 'react';

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
};

export function useRecentValues() {
  const [recentValues, setRecentValues] = useState<RecentValues>(DEFAULT_VALUES);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setRecentValues({ ...DEFAULT_VALUES, ...JSON.parse(stored) });
      }
    } catch (e) {
      console.error('Failed to load recent values', e);
    }
  }, []);

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

  return { recentValues, addValues };
}
