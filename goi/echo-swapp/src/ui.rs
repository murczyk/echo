use actix_web::{get, HttpResponse, Responder};

const ECHO_LOGO_SVG: &str =
    include_str!("../../../wdintel-web/static/img/echo-logo-white.svg");

#[get("/")]
pub async fn index() -> impl Responder {
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(INDEX_HTML)
}

#[get("/echo-logo.svg")]
pub async fn echo_logo() -> impl Responder {
    HttpResponse::Ok()
        .content_type("image/svg+xml; charset=utf-8")
        .body(ECHO_LOGO_SVG)
}

const INDEX_HTML: &str = r#"<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MESSENGERS</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-zinc-950 text-zinc-100">
  <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
    <header class="flex flex-col gap-3 border-b border-zinc-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div class="flex items-center gap-3">
          <img src="echo-logo.svg" alt="ECHO" class="h-8 w-auto shrink-0" />
          <h1 class="text-2xl font-semibold tracking-normal">MESSENGERS</h1>
        </div>
      </div>
      <div class="flex gap-2">
        <button id="globalPauseBtn" class="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" type="button" aria-label="Зупинити синхронізацію" title="Зупинити синхронізацію"></button>
        <button id="refreshBtn" class="h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-900">Оновити</button>
      </div>
    </header>

    <section class="grid gap-4 lg:grid-cols-[360px_1fr]">
      <form id="createForm" class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
        <h2 class="text-base font-medium">Новий месенджер</h2>
        <div class="mt-4 grid gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Назва</span>
            <input id="nameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="goi-signal-1" required />
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Месенджер</span>
            <select id="kindInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
              <option value="signal">Signal</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Телефон</span>
            <input id="phoneInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="+380000000000" required />
          </label>
          <button class="mt-2 h-10 rounded-md bg-sky-500 px-4 text-sm font-medium text-zinc-950 hover:bg-sky-400" type="submit">Створити</button>
          <p id="formMsg" class="min-h-5 text-sm text-zinc-400"></p>
        </div>
      </form>

      <section class="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <div class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-base font-medium">Месенджери</h2>
        </div>
        <div id="list" class="grid gap-3 p-4"></div>
      </section>
    </section>
  </main>

  <dialog id="qrDialog" class="w-[min(92vw,420px)] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-100 backdrop:bg-black/70">
    <div class="border-b border-zinc-800 px-4 py-3">
      <h2 id="qrTitle" class="text-base font-medium">Підключення месенджера</h2>
    </div>
    <div class="grid gap-4 p-4 text-center">
      <div id="qrBox" class="grid min-h-72 place-items-center rounded-md bg-white p-4 text-zinc-950">Завантаження...</div>
      <p id="qrStatus" class="text-sm text-zinc-400">Очікування підключення...</p>
      <div class="flex justify-center gap-2">
        <button id="refreshQr" class="inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" type="button" aria-label="Оновити QR" title="Оновити QR"></button>
        <button id="closeQr" class="h-10 rounded-md border border-zinc-700 px-4 text-sm hover:bg-zinc-900">Закрити</button>
      </div>
    </div>
  </dialog>

  <script>
    const list = document.getElementById('list');
    const formMsg = document.getElementById('formMsg');
    const qrDialog = document.getElementById('qrDialog');
    const qrBox = document.getElementById('qrBox');
    const qrTitle = document.getElementById('qrTitle');
    const qrStatus = document.getElementById('qrStatus');
    const refreshQr = document.getElementById('refreshQr');
    const globalPauseBtn = document.getElementById('globalPauseBtn');
    let pollTimer = null;
    let globalPaused = false;
    let currentQrName = null;

    function appBasePath() {
      const path = window.location.pathname;
      const base = path.endsWith('/') ? path.slice(0, -1) : path.replace(/\/[^/]*$/, '');
      return base === '/' ? '' : base;
    }

    const basePath = appBasePath();

    function appUrl(path) {
      return `${basePath}${path}`;
    }

    function apiBase(name) {
      return `${window.location.origin}${appUrl(`/api/${name}`)}`;
    }

    async function request(url, options = {}) {
      const rsp = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      if (!rsp.ok) throw new Error(await rsp.text());
      return rsp.headers.get('content-type')?.includes('application/json') ? rsp.json() : null;
    }

    async function load() {
      await loadGlobalPause();
      list.innerHTML = '<div class="p-4 text-sm text-zinc-400">Завантаження...</div>';
      try {
        const data = await request(appUrl('/ui-api/messengers'));
        if (data.length === 0) {
          list.innerHTML = '<div class="p-4 text-sm text-zinc-400">Месенджерів ще немає.</div>';
          return;
        }
        list.innerHTML = '';
        data.forEach(renderRow);
      } catch (err) {
        list.innerHTML = `<div class="p-4 text-sm text-red-400">${err.message}</div>`;
      }
    }

    function copyIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
    }

    function checkIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5"></path>
        </svg>
      `;
    }

    function refreshIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path>
          <path d="M3 21v-5h5"></path>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path>
          <path d="M16 8h5V3"></path>
        </svg>
      `;
    }

    function pauseIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="6" y="4" width="4" height="16"></rect>
          <rect x="14" y="4" width="4" height="16"></rect>
        </svg>
      `;
    }

    function playIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="6 3 20 12 6 21 6 3"></polygon>
        </svg>
      `;
    }

    function deleteIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h18"></path>
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6"></path>
          <path d="M14 11v6"></path>
        </svg>
      `;
    }

    function updateGlobalPauseButton() {
      globalPauseBtn.innerHTML = globalPaused ? playIcon() : pauseIcon();
      globalPauseBtn.setAttribute('aria-label', globalPaused ? 'Відновити всю синхронізацію' : 'Зупинити всю синхронізацію');
      globalPauseBtn.setAttribute('title', globalPaused ? 'Відновити всю синхронізацію' : 'Зупинити всю синхронізацію');
      globalPauseBtn.className = globalPaused
        ? 'inline-flex h-10 w-10 items-center justify-center rounded-md border border-amber-700 text-amber-300 hover:bg-amber-950/40'
        : 'inline-flex h-10 w-10 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900';
    }

    async function loadGlobalPause() {
      const state = await request(appUrl('/ui-api/sync-pause'));
      globalPaused = state.isPaused;
      updateGlobalPauseButton();
    }

    function renderRow(item) {
      const row = document.createElement('article');
      row.className = 'grid gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-4';
      row.innerHTML = `
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="truncate text-base font-medium">${item.name}</h3>
              <span class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">${item.kind}</span>
              <span class="${item.isLinked ? 'text-emerald-400' : 'text-amber-400'} text-sm">${item.isLinked ? 'підключено' : 'не підключено'}</span>
              ${item.isPaused ? '<span class="text-sm text-amber-300">синхронізацію зупинено</span>' : ''}
            </div>
            <p class="mt-1 text-sm text-zinc-400">${item.phone || ''}</p>
          </div>
          <div class="flex gap-2">
            ${item.isLinked
              ? `<button data-unlink="${item.name}" class="h-9 rounded-md border border-red-700 px-3 text-sm text-red-400 hover:bg-red-950/40">Відключити</button>`
              : `<button data-link="${item.name}" class="h-9 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900">Підключити</button>`}
            <button data-pause="${item.name}" data-paused="${item.isPaused}" class="inline-flex h-9 w-9 items-center justify-center rounded-md border ${item.isPaused ? 'border-amber-700 text-amber-300 hover:bg-amber-950/40' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-900'}" type="button" aria-label="${item.isPaused ? 'Відновити синхронізацію' : 'Зупинити синхронізацію'}" title="${item.isPaused ? 'Відновити синхронізацію' : 'Зупинити синхронізацію'}">${item.isPaused ? playIcon() : pauseIcon()}</button>
            <button data-copy="${item.name}" class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-950 hover:bg-white" type="button" aria-label="Скопіювати URL API" title="Скопіювати URL API">${copyIcon()}</button>
            <button data-delete="${item.name}" class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-500" type="button" aria-label="Видалити месенджер" title="Видалити месенджер">${deleteIcon()}</button>
          </div>
        </div>
        <code class="block overflow-hidden text-ellipsis whitespace-nowrap rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-400">${apiBase(item.name)}</code>
      `;
      list.appendChild(row);
    }

    document.getElementById('createForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      formMsg.textContent = 'Створення...';
      try {
        await request(appUrl('/ui-api/messengers'), {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('nameInput').value.trim(),
            kind: document.getElementById('kindInput').value,
            phone: document.getElementById('phoneInput').value.trim(),
          }),
        });
        formMsg.textContent = 'Створено.';
        event.target.reset();
        await load();
      } catch (err) {
        formMsg.textContent = err.message;
      }
    });

    list.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;

      const linkName = button.dataset.link;
      const unlinkName = button.dataset.unlink;
      const copyName = button.dataset.copy;
      const deleteName = button.dataset.delete;
      const pauseName = button.dataset.pause;

      if (pauseName) {
        await request(appUrl(`/ui-api/messengers/${pauseName}/pause`), {
          method: 'POST',
          body: JSON.stringify({ isPaused: button.dataset.paused !== 'true' }),
        });
        await load();
      }
      if (copyName) {
        await navigator.clipboard.writeText(apiBase(copyName));
        button.innerHTML = checkIcon();
        setTimeout(() => button.innerHTML = copyIcon(), 1200);
      }
      if (deleteName) {
        if (!confirm(`Видалити месенджер ${deleteName}?`)) return;
        await request(appUrl(`/ui-api/messengers/${deleteName}`), { method: 'DELETE' });
        await load();
      }
      if (unlinkName) {
        if (!confirm(`Відключити месенджер ${unlinkName}?`)) return;
        await request(appUrl(`/ui-api/messengers/${unlinkName}/unlink`), { method: 'POST' });
        await load();
      }
      if (linkName) openQr(linkName);
    });

    async function openQr(name) {
      currentQrName = name;
      qrTitle.textContent = `Підключення ${name}`;
      qrDialog.showModal();
      await loadQr(name);
    }

    async function loadQr(name) {
      clearInterval(pollTimer);
      qrBox.textContent = 'Завантаження...';
      qrStatus.textContent = 'Очікування підключення...';
      refreshQr.disabled = true;
      try {
        const rsp = await request(appUrl(`/ui-api/messengers/${name}/link`), { method: 'POST' });
        qrBox.innerHTML = `<img class="max-h-72 max-w-full" src="${rsp.qrCodeBase64}" alt="QR code" />`;
        pollTimer = setInterval(async () => {
          const status = await request(appUrl(`/ui-api/messengers/${name}/status`));
          if (status.isLinked) {
            clearInterval(pollTimer);
            qrStatus.textContent = 'Підключено.';
            await load();
          }
        }, 3000);
      } catch (err) {
        qrBox.textContent = err.message;
        qrStatus.textContent = 'Не вдалося підключити';
      } finally {
        refreshQr.disabled = false;
      }
    }

    refreshQr.innerHTML = refreshIcon();
    refreshQr.addEventListener('click', () => {
      if (currentQrName) loadQr(currentQrName);
    });

    document.getElementById('closeQr').addEventListener('click', () => {
      clearInterval(pollTimer);
      qrDialog.close();
    });
    globalPauseBtn.addEventListener('click', async () => {
      await request(appUrl('/ui-api/sync-pause'), {
        method: 'POST',
        body: JSON.stringify({ isPaused: !globalPaused }),
      });
      await load();
    });
    document.getElementById('refreshBtn').addEventListener('click', load);
    load();
  </script>
</body>
</html>"#;
