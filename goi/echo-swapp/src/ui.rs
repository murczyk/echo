use actix_web::{get, HttpResponse, Responder};

#[get("/")]
pub async fn index() -> impl Responder {
    HttpResponse::Ok()
        .content_type("text/html; charset=utf-8")
        .body(INDEX_HTML)
}

const INDEX_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Echo Swapp</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-zinc-950 text-zinc-100">
  <main class="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
    <header class="flex flex-col gap-3 border-b border-zinc-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-normal">Echo Swapp</h1>
        <p class="mt-1 text-sm text-zinc-400">Signal and WhatsApp API adapters</p>
      </div>
      <button id="refreshBtn" class="h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-900">Refresh</button>
    </header>

    <section class="grid gap-4 lg:grid-cols-[360px_1fr]">
      <form id="createForm" class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
        <h2 class="text-base font-medium">New messenger</h2>
        <div class="mt-4 grid gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Name</span>
            <input id="nameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="goi-signal-1" required />
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Messenger</span>
            <select id="kindInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
              <option value="signal">Signal</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Phone</span>
            <input id="phoneInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="+380000000000" required />
          </label>
          <button class="mt-2 h-10 rounded-md bg-sky-500 px-4 text-sm font-medium text-zinc-950 hover:bg-sky-400" type="submit">Create</button>
          <p id="formMsg" class="min-h-5 text-sm text-zinc-400"></p>
        </div>
      </form>

      <section class="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <div class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-base font-medium">Messengers</h2>
        </div>
        <div id="list" class="grid gap-3 p-4"></div>
      </section>
    </section>
  </main>

  <dialog id="qrDialog" class="w-[min(92vw,420px)] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-100 backdrop:bg-black/70">
    <div class="border-b border-zinc-800 px-4 py-3">
      <h2 id="qrTitle" class="text-base font-medium">Link messenger</h2>
    </div>
    <div class="grid gap-4 p-4 text-center">
      <div id="qrBox" class="grid min-h-72 place-items-center rounded-md bg-white p-4 text-zinc-950">Loading...</div>
      <p id="qrStatus" class="text-sm text-zinc-400">Waiting for link...</p>
      <button id="closeQr" class="h-10 rounded-md border border-zinc-700 px-4 text-sm hover:bg-zinc-900">Close</button>
    </div>
  </dialog>

  <script>
    const list = document.getElementById('list');
    const formMsg = document.getElementById('formMsg');
    const qrDialog = document.getElementById('qrDialog');
    const qrBox = document.getElementById('qrBox');
    const qrTitle = document.getElementById('qrTitle');
    const qrStatus = document.getElementById('qrStatus');
    let pollTimer = null;

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
      list.innerHTML = '<div class="p-4 text-sm text-zinc-400">Loading...</div>';
      try {
        const data = await request(appUrl('/ui-api/messengers'));
        if (data.length === 0) {
          list.innerHTML = '<div class="p-4 text-sm text-zinc-400">No messengers yet.</div>';
          return;
        }
        list.innerHTML = '';
        data.forEach(renderRow);
      } catch (err) {
        list.innerHTML = `<div class="p-4 text-sm text-red-400">${err.message}</div>`;
      }
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
              <span class="${item.isLinked ? 'text-emerald-400' : 'text-amber-400'} text-sm">${item.isLinked ? 'linked' : 'not linked'}</span>
            </div>
            <p class="mt-1 text-sm text-zinc-400">${item.phone || ''}</p>
          </div>
          <div class="flex gap-2">
            <button data-link="${item.name}" class="h-9 rounded-md border border-zinc-700 px-3 text-sm hover:bg-zinc-900">Link</button>
            <button data-copy="${item.name}" class="h-9 rounded-md bg-zinc-100 px-3 text-sm text-zinc-950 hover:bg-white">Copy API URL</button>
          </div>
        </div>
        <code class="block overflow-hidden text-ellipsis whitespace-nowrap rounded bg-zinc-900 px-3 py-2 text-xs text-zinc-400">${apiBase(item.name)}</code>
      `;
      list.appendChild(row);
    }

    document.getElementById('createForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      formMsg.textContent = 'Creating...';
      try {
        await request(appUrl('/ui-api/messengers'), {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('nameInput').value.trim(),
            kind: document.getElementById('kindInput').value,
            phone: document.getElementById('phoneInput').value.trim(),
          }),
        });
        formMsg.textContent = 'Created.';
        event.target.reset();
        await load();
      } catch (err) {
        formMsg.textContent = err.message;
      }
    });

    list.addEventListener('click', async (event) => {
      const linkName = event.target.dataset.link;
      const copyName = event.target.dataset.copy;
      if (copyName) {
        await navigator.clipboard.writeText(apiBase(copyName));
        event.target.textContent = 'Copied';
        setTimeout(() => event.target.textContent = 'Copy API URL', 1200);
      }
      if (linkName) openQr(linkName);
    });

    async function openQr(name) {
      clearInterval(pollTimer);
      qrTitle.textContent = `Link ${name}`;
      qrBox.textContent = 'Loading...';
      qrStatus.textContent = 'Waiting for link...';
      qrDialog.showModal();
      try {
        const rsp = await request(appUrl(`/ui-api/messengers/${name}/link`), { method: 'POST' });
        qrBox.innerHTML = `<img class="max-h-72 max-w-full" src="${rsp.qrCodeBase64}" alt="QR code" />`;
        pollTimer = setInterval(async () => {
          const status = await request(appUrl(`/ui-api/messengers/${name}/status`));
          if (status.isLinked) {
            clearInterval(pollTimer);
            qrStatus.textContent = 'Linked.';
            await load();
          }
        }, 3000);
      } catch (err) {
        qrBox.textContent = err.message;
        qrStatus.textContent = 'Failed';
      }
    }

    document.getElementById('closeQr').addEventListener('click', () => {
      clearInterval(pollTimer);
      qrDialog.close();
    });
    document.getElementById('refreshBtn').addEventListener('click', load);
    load();
  </script>
</body>
</html>"#;
