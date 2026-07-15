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

    <nav class="flex gap-2 border-b border-zinc-800" aria-label="Розділи">
      <button id="integrationsTabBtn" class="border-b-2 border-sky-400 px-3 py-2 text-sm text-zinc-100" type="button">Інтеграції</button>
      <button id="automationsTabBtn" class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100" type="button">Автоматизації</button>
    </nav>

    <section id="integrationsTab" class="grid gap-4 lg:grid-cols-[360px_1fr]">
      <form id="createForm" class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
        <h2 class="text-base font-medium">Новий месенджер</h2>
        <div class="mt-4 grid gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Назва</span>
            <input id="nameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="goi-signal-1" aria-describedby="nameHint" required />
            <span id="nameHint" class="text-xs text-zinc-500">Довільна назва вашої інтеграції, наприклад goi signal 333 ombr</span>
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

    <section id="automationsTab" class="hidden grid gap-4 lg:grid-cols-[360px_1fr]">
      <form id="automationForm" class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
        <p class="mb-4 rounded-md border border-zinc-800 bg-zinc-800/70 p-3 text-sm text-zinc-300">
          Автоматизація пересилає нові повідомлення з вибраної групи у цільову, якщо текст містить задані ключові слова або частоти. Можна враховувати координати, полігон, вік повідомлення та вкладення.
        </p>
        <h2 class="text-base font-medium">Нова автоматизація</h2>
        <div class="mt-4 grid gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Назва</span>
            <input id="automationNameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="Висновки 3 АК" />
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Акаунт читання</span>
            <select id="sourceAccountInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Група-джерело</span>
            <select id="sourceGroupInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Акаунт надсилання</span>
            <select id="targetAccountInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Група-призначення</span>
            <select id="targetGroupInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Ключові слова</span>
            <input id="keywordTokenInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="слово, Enter" />
            <div id="keywordTokens" class="flex min-h-7 flex-wrap gap-1"></div>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Частоти</span>
            <input id="frequencyTokenInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="149.200, Enter" />
            <div id="frequencyTokens" class="flex min-h-7 flex-wrap gap-1"></div>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Ігнорувати повідомлення старші за, хв</span>
            <input id="staleMinutesInput" type="number" min="0" value="60" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required />
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Повідомлення із координатами</span>
            <select id="coordinatePresenceInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
              <option value="any">--</option>
              <option value="skip_with_coordinates">Ігнорувати повідомлення із координатами</option>
              <option value="skip_without_coordinates">Ігнорувати повідомлення без координат</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Полігон</span>
            <select id="polygonModeInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
              <option value="none">Не фільтрувати</option>
              <option value="inside">Ігнорувати всередині</option>
              <option value="outside">Ігнорувати зовні</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Координати полігону</span>
            <textarea id="polygonCoordinatesInput" class="min-h-24 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-sky-500" placeholder="37U DR 05997 22279&#10;37U DR 06020 22340&#10;37U DR 06090 22270"></textarea>
          </label>
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            <input id="resendAttachmentsInput" type="checkbox" class="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
            Пересилати вкладення
          </label>
          <button class="mt-2 h-10 rounded-md bg-sky-500 px-4 text-sm font-medium text-zinc-950 hover:bg-sky-400" type="submit">Створити</button>
          <p id="automationFormMsg" class="min-h-5 text-sm text-zinc-400"></p>
        </div>
      </form>

      <section class="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <div class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-base font-medium">Автоматизації</h2>
        </div>
        <div id="automationList" class="grid gap-3 p-4"></div>
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
    const automationList = document.getElementById('automationList');
    const formMsg = document.getElementById('formMsg');
    const automationFormMsg = document.getElementById('automationFormMsg');
    const qrDialog = document.getElementById('qrDialog');
    const qrBox = document.getElementById('qrBox');
    const qrTitle = document.getElementById('qrTitle');
    const qrStatus = document.getElementById('qrStatus');
    const refreshQr = document.getElementById('refreshQr');
    const globalPauseBtn = document.getElementById('globalPauseBtn');
    let pollTimer = null;
    let globalPaused = false;
    let currentQrName = null;
    let activeTab = 'integrations';
    let automationAccounts = [];
    let automationGroups = [];
    let keywordTokens = [];
    let frequencyTokens = [];

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
      await loadAutomationAccounts();
      await loadAutomationGroups();
      await loadAutomations();
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

    function setActiveTab(tab) {
      activeTab = tab;
      document.getElementById('integrationsTab').classList.toggle('hidden', tab !== 'integrations');
      document.getElementById('automationsTab').classList.toggle('hidden', tab !== 'automations');
      document.getElementById('integrationsTabBtn').className = tab === 'integrations'
        ? 'border-b-2 border-sky-400 px-3 py-2 text-sm text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100';
      document.getElementById('automationsTabBtn').className = tab === 'automations'
        ? 'border-b-2 border-sky-400 px-3 py-2 text-sm text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100';
    }

    async function loadAutomationGroups() {
      automationGroups = await request(appUrl('/ui-api/automation-groups'));
      renderAutomationFormSelects();
    }

    async function loadAutomationAccounts() {
      automationAccounts = await request(appUrl('/ui-api/automation-accounts'));
      renderAutomationFormSelects();
    }

    async function loadAutomations() {
      automationList.innerHTML = '<div class="p-4 text-sm text-zinc-400">Завантаження...</div>';
      try {
        const data = await request(appUrl('/ui-api/automations'));
        if (data.length === 0) {
          automationList.innerHTML = '<div class="p-4 text-sm text-zinc-400">Автоматизацій ще немає.</div>';
          return;
        }
        automationList.innerHTML = '';
        data.forEach(renderAutomationRow);
      } catch (err) {
        automationList.innerHTML = `<div class="p-4 text-sm text-red-400">${err.message}</div>`;
      }
    }

    function renderAutomationFormSelects() {
      renderAccountSelect(document.getElementById('sourceAccountInput'));
      renderAccountSelect(document.getElementById('targetAccountInput'));
      renderGroupSelect(
        document.getElementById('sourceGroupInput'),
        Number(document.getElementById('sourceAccountInput').value),
      );
      renderGroupSelect(
        document.getElementById('targetGroupInput'),
        Number(document.getElementById('targetAccountInput').value),
      );
    }

    function renderAccountSelect(select) {
      const current = Number(select.value);
      select.innerHTML = '<option value="">Оберіть акаунт</option>' + automationAccounts.map(account => {
        const linked = account.isLinked ? '' : ' · не підключено';
        const style = account.isLinked ? '' : ' style="color:#71717a"';
        return `<option value="${account.id}"${style}>${account.name} · ${account.phone}${linked}</option>`;
      }).join('');
      if (automationAccounts.some(account => account.id === current)) {
        select.value = String(current);
      } else if (automationAccounts.length > 0) {
        select.value = String(automationAccounts[0].id);
      }
    }

    function renderGroupSelect(select, accountId) {
      const current = select.value;
      const groups = automationGroups.filter(group => group.accountId === accountId);
      select.innerHTML = '<option value="">Оберіть групу</option>' + groups.map(group => {
        return `<option value="${group.id}">${group.name} · ${group.messengerName}</option>`;
      }).join('');
      if (groups.some(group => String(group.id) === current)) {
        select.value = current;
      } else if (groups.length > 0) {
        select.value = String(groups[0].id);
      }
    }

    function renderToken(containerId, tokens, removePrefix) {
      const container = document.getElementById(containerId);
      container.innerHTML = tokens.map((token, index) => `
        <button data-${removePrefix}-token="${index}" class="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-700" type="button">${token} ×</button>
      `).join('');
    }

    function addToken(input, tokens, containerId, removePrefix) {
      const parts = input.value.split(',').map(token => token.trim().toLowerCase()).filter(Boolean);
      tokens.push(...parts);
      const unique = [...new Set(tokens)].sort();
      tokens.splice(0, tokens.length, ...unique);
      input.value = '';
      renderToken(containerId, tokens, removePrefix);
    }

    function bindTokenInput(inputId, tokens, containerId, removePrefix) {
      const input = document.getElementById(inputId);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          addToken(input, tokens, containerId, removePrefix);
        }
      });
      input.addEventListener('blur', () => addToken(input, tokens, containerId, removePrefix));
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

    function renderAutomationRow(item) {
      const row = document.createElement('article');
      row.className = 'grid gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-4';
      const usage = item.usage || { last24h: 0, last7d: 0, allTime: 0 };
      const checkpoint = item.checkpointAt > 0
        ? new Date(item.checkpointAt).toLocaleString('uk-UA')
        : 'ще не синхронізовано';
      const warnings = [];
      if (!item.isPaused && !item.sourceAccountIsLinked) {
        warnings.push('Акаунт читання не підключено: нові повідомлення не синхронізуються.');
      }
      if (!item.isPaused && !item.targetAccountIsLinked) {
        warnings.push('Акаунт надсилання не підключено: повідомлення не пересилаються.');
      }
      row.innerHTML = `
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="truncate text-base font-medium">${item.name || `${item.sourceGroupName} → ${item.targetGroupName}`}</h3>
              <span class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">${item.sourceMessengerKind} → ${item.targetMessengerKind}</span>
              <span class="${item.status === 'error' ? 'text-red-400' : item.isPaused ? 'text-amber-300' : 'text-emerald-400'} text-sm">${item.isPaused ? 'пауза' : item.status}</span>
            </div>
            <p class="mt-1 text-sm text-zinc-400">${item.sourceAccountName} / ${item.sourceGroupName} → ${item.targetAccountName} / ${item.targetGroupName}</p>
            <p class="mt-1 text-xs text-zinc-500">${[...item.keywordTokens, ...item.frequencyTokens].join(', ')}</p>
            <p class="mt-1 text-xs text-zinc-500">Синхронізовано до: ${checkpoint}</p>
            ${warnings.map(warning => `<p class="mt-1 text-xs text-amber-300">${warning}</p>`).join('')}
            ${item.lastError ? `<p class="mt-1 text-xs text-red-400">${item.lastError}</p>` : ''}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <span class="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300">${usage.last24h}/${usage.last7d}/${usage.allTime}</span>
            <button data-automation-pause="${item.id}" data-paused="${item.isPaused}" class="inline-flex h-9 w-9 items-center justify-center rounded-md border ${item.isPaused ? 'border-amber-700 text-amber-300 hover:bg-amber-950/40' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-900'}" type="button" aria-label="${item.isPaused ? 'Запустити автоматизацію' : 'Зупинити автоматизацію'}" title="${item.isPaused ? 'Запустити автоматизацію' : 'Зупинити автоматизацію'}">${item.isPaused ? playIcon() : pauseIcon()}</button>
            <button data-automation-delete="${item.id}" class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-500" type="button" aria-label="Видалити автоматизацію" title="Видалити автоматизацію">${deleteIcon()}</button>
          </div>
        </div>
      `;
      automationList.appendChild(row);
    }

    function polygonCoordinates() {
      return document.getElementById('polygonCoordinatesInput').value
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean);
    }

    function automationPayload() {
      return {
        name: document.getElementById('automationNameInput').value.trim(),
        sourceAccountId: Number(document.getElementById('sourceAccountInput').value),
        sourceGroupId: Number(document.getElementById('sourceGroupInput').value),
        targetAccountId: Number(document.getElementById('targetAccountInput').value),
        targetGroupId: Number(document.getElementById('targetGroupInput').value),
        keywordTokens,
        frequencyTokens,
        staleMessageCutoffMinutes: Number(document.getElementById('staleMinutesInput').value),
        resendAttachments: document.getElementById('resendAttachmentsInput').checked,
        coordinatePresenceMode: document.getElementById('coordinatePresenceInput').value,
        polygonFilterMode: document.getElementById('polygonModeInput').value,
        polygonCoordinates: polygonCoordinates(),
      };
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

    document.getElementById('automationForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      addToken(document.getElementById('keywordTokenInput'), keywordTokens, 'keywordTokens', 'keyword');
      addToken(document.getElementById('frequencyTokenInput'), frequencyTokens, 'frequencyTokens', 'frequency');
      automationFormMsg.textContent = 'Створення...';
      try {
        await request(appUrl('/ui-api/automations'), {
          method: 'POST',
          body: JSON.stringify(automationPayload()),
        });
        automationFormMsg.textContent = 'Створено.';
        event.target.reset();
        keywordTokens = [];
        frequencyTokens = [];
        renderToken('keywordTokens', keywordTokens, 'keyword');
        renderToken('frequencyTokens', frequencyTokens, 'frequency');
        updatePolygonAvailability();
        renderAutomationFormSelects();
        await loadAutomations();
      } catch (err) {
        automationFormMsg.textContent = err.message;
      }
    });

    document.getElementById('sourceAccountInput').addEventListener('change', () => {
      renderGroupSelect(
        document.getElementById('sourceGroupInput'),
        Number(document.getElementById('sourceAccountInput').value),
      );
    });

    document.getElementById('targetAccountInput').addEventListener('change', () => {
      renderGroupSelect(
        document.getElementById('targetGroupInput'),
        Number(document.getElementById('targetAccountInput').value),
      );
    });

    document.getElementById('keywordTokens').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button?.dataset.keywordToken) return;
      keywordTokens.splice(Number(button.dataset.keywordToken), 1);
      renderToken('keywordTokens', keywordTokens, 'keyword');
    });

    document.getElementById('frequencyTokens').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button?.dataset.frequencyToken) return;
      frequencyTokens.splice(Number(button.dataset.frequencyToken), 1);
      renderToken('frequencyTokens', frequencyTokens, 'frequency');
    });

    automationList.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const pauseId = button.dataset.automationPause;
      const deleteId = button.dataset.automationDelete;
      if (pauseId) {
        await request(appUrl(`/ui-api/automations/${pauseId}/pause`), {
          method: 'POST',
          body: JSON.stringify({ isPaused: button.dataset.paused !== 'true' }),
        });
        await loadAutomations();
      }
      if (deleteId) {
        if (!confirm('Видалити автоматизацію?')) return;
        await request(appUrl(`/ui-api/automations/${deleteId}`), { method: 'DELETE' });
        await loadAutomations();
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

    function updatePolygonAvailability() {
      const disabled = document.getElementById('coordinatePresenceInput').value === 'skip_with_coordinates';
      document.getElementById('polygonModeInput').disabled = disabled;
      document.getElementById('polygonCoordinatesInput').disabled = disabled;
      if (disabled) {
        document.getElementById('polygonModeInput').value = 'none';
        document.getElementById('polygonCoordinatesInput').value = '';
      }
    }

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
    document.getElementById('integrationsTabBtn').addEventListener('click', () => setActiveTab('integrations'));
    document.getElementById('automationsTabBtn').addEventListener('click', () => setActiveTab('automations'));
    document.getElementById('coordinatePresenceInput').addEventListener('change', updatePolygonAvailability);
    bindTokenInput('keywordTokenInput', keywordTokens, 'keywordTokens', 'keyword');
    bindTokenInput('frequencyTokenInput', frequencyTokens, 'frequencyTokens', 'frequency');
    updatePolygonAvailability();
    load();
  </script>
</body>
</html>"#;
