export function buildDocxHtmlDocument(bodyHtml: string, zoom: number): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
    <style>
      :root {
        color-scheme: dark;
        --docx-preview-zoom: ${zoom}%;
      }
      html, body { margin: 0; padding: 0; background: #111821; color: #111827; }
      body {
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 14px;
        line-height: 1.45;
        padding: 28px 20px 42px;
        word-break: break-word;
        overflow-wrap: anywhere;
      }
      .docx-preview-page {
        box-sizing: border-box;
        width: min(860px, 100%);
        min-height: calc(100vh - 70px);
        margin: 0 auto;
        padding: 42px 48px;
        background: #fff;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 10px;
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.26);
        color: #111827;
        zoom: var(--docx-preview-zoom);
      }
      img, video, canvas, svg { max-width: 100%; height: auto; }
      table { border-collapse: collapse; max-width: 100%; }
      td, th { border: 1px solid rgba(17, 24, 39, 0.22); padding: 4px 6px; vertical-align: top; }
      a { color: #1d4ed8; }
      blockquote { border-left: 3px solid rgba(17, 24, 39, 0.18); margin: 0 0 1em; padding-left: 12px; color: rgba(17, 24, 39, 0.76); }
      pre { white-space: pre-wrap; }
      @media (max-width: 720px) {
        body { padding: 16px 10px 28px; }
        .docx-preview-page { padding: 24px 18px; border-radius: 8px; }
      }
    </style>
  </head>
  <body><main class="docx-preview-page">${bodyHtml}</main></body>
</html>`;
}
