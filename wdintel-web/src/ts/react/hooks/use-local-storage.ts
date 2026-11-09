// local storage related logic comes here
export function useLocalStorage() {
  function getItem(key: string) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.warn(`Failed to read local storage item "${key}"`, error);
      return null;
    }
  }

  function setItem(key: string, value: string) {
    try {
      return localStorage.setItem(key, value);
    } catch (error) {
      console.warn(`Failed to save local storage item "${key}"`, error);
    }
  }

  function removeItem(key: string) {
    try {
      return localStorage.removeItem(key);
    } catch (error) {
      console.warn(`Failed to remove local storage item "${key}"`, error);
    }
  }

  return { getItem, setItem, removeItem };
}
