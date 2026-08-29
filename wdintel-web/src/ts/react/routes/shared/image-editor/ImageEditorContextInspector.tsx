import type { ReactNode } from 'react';

export function ImageEditorContextInspector({
  children,
  bordered = true,
}: {
  children: ReactNode;
  bordered?: boolean;
}) {
  return (
    <div className="absolute left-1/2 top-2 z-30 w-max max-w-[calc(100%-24px)] -translate-x-1/2">
      <div
        className={`flex min-h-12 max-w-full flex-wrap items-center gap-3 rounded-echo-md bg-echo-surface px-2 py-2 shadow-echo-md ${bordered ? 'border border-echo-border' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
