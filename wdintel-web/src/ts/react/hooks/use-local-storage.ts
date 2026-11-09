import { useMemo } from 'react';

// local storage related logic comes here
export function useLocalStorage() {
  return useMemo(() => {
    const pendingItems = new Map<string, string | null>();

    function getItem(key: string) {
      if (pendingItems.has(key)) return pendingItems.get(key) ?? null;

      try {
        return localStorage.getItem(key);
      } catch (error) {
        console.warn(`Failed to read local storage item "${key}"`, error);
        return null;
      }
    }

    function setItem(key: string, value: string) {
      try {
        localStorage.setItem(key, value);
        pendingItems.delete(key);
      } catch (error) {
        pendingItems.set(key, value);
        console.warn(`Failed to save local storage item "${key}"`, error);
      }
    }

    function removeItem(key: string) {
      try {
        localStorage.removeItem(key);
        pendingItems.delete(key);
      } catch (error) {
        pendingItems.set(key, null);
        console.warn(`Failed to remove local storage item "${key}"`, error);
      }
    }

    return { getItem, setItem, removeItem };
  }, []);
}
