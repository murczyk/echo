// local storage related logic comes here
export function useLocalStorage() {
  function getItem(key: string) {
    return localStorage.getItem(key);
  }

  function setItem(key: string, value: string) {
    return localStorage.setItem(key, value);
  }

  function removeItem(key: string) {
    return localStorage.removeItem(key);
  }

  return { getItem, setItem, removeItem };
}
