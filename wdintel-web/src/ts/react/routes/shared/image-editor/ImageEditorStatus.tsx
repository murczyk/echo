export function ImageEditorStatus({ tool }: { tool: 'conceal' | 'magnifier' | string }) {
  if (tool !== 'conceal' && tool !== 'magnifier') return null;
  return (
    <div className="shrink-0 px-2 py-1">
      {tool === 'conceal' ? (
        <span className="text-echo-sm text-echo-text">
          Для надійного приховування конфіденційних даних використовуйте «Редакція». Розмиття й
          пікселізація не гарантують незворотного приховування.
        </span>
      ) : null}
      {tool === 'magnifier' ? (
        <span className="text-echo-sm text-echo-text">
          Клацніть зображення, щоб вибрати область для лупи. Alt+клацніть вибрану лупу, щоб змінити
          її джерело.
        </span>
      ) : null}
    </div>
  );
}
