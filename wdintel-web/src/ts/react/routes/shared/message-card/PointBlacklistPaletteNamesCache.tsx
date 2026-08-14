import { createContext, useContext, useRef, type ReactNode } from 'react';

type PointBlacklistPaletteNamesCache = Map<number, string>;

const PointBlacklistPaletteNamesCacheContext =
  createContext<PointBlacklistPaletteNamesCache | null>(null);

export function PointBlacklistPaletteNamesCacheProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<PointBlacklistPaletteNamesCache>(new Map());
  return (
    <PointBlacklistPaletteNamesCacheContext.Provider value={cacheRef.current}>
      {children}
    </PointBlacklistPaletteNamesCacheContext.Provider>
  );
}

export function usePointBlacklistPaletteNamesCache(): PointBlacklistPaletteNamesCache | null {
  return useContext(PointBlacklistPaletteNamesCacheContext);
}
