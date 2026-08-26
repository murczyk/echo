import type { ReactNode } from 'react';

export function ImageEditorContextInspector({ children }: { children: ReactNode }) {
  return (
    <div className="absolute left-1/2 top-2 z-30 max-w-[calc(100%-24px)] -translate-x-1/2">
      <div className="flex h-12 max-w-full items-center overflow-x-auto overflow-y-hidden rounded-echo-md border border-echo-border bg-echo-surface px-3 shadow-echo-md">
        {children}
      </div>
    </div>
  );
}
