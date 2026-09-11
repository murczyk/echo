export function DeviceFileContentPane() {
  return (
    <section
      aria-labelledby="device-file-content-title"
      data-testid="device-file-content-pane"
      className="flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-echo-sm p-echo-xl text-center"
    >
      <h2 id="device-file-content-title" className="m-0 text-echo-lg font-semibold text-echo-text">
        Вміст файлу
      </h2>
      <p className="m-0 max-w-prose text-echo-sm text-echo-text-muted">
        Тут відображатиметься вміст вибраного файлу, коли перегляд контенту стане доступним.
      </p>
    </section>
  );
}
