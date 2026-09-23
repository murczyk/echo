import { createContext, useContext, type ReactNode } from 'react';

const RadioFeaturesContext = createContext(false);

export function RadioFeaturesProvider({
  allowed,
  children,
}: {
  allowed: boolean;
  children: ReactNode;
}) {
  return <RadioFeaturesContext.Provider value={allowed}>{children}</RadioFeaturesContext.Provider>;
}

export function useRadioFeatures(): boolean {
  return useContext(RadioFeaturesContext);
}
