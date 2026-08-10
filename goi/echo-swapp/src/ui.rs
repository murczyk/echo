use actix_web::{get, HttpResponse, Responder};

const ECHO_LOGO_SVG: &str =
    include_str!("../../../wdintel-web/static/img/echo-logo-white.svg");
const LEAFLET_CSS: &str =
    include_str!("../../swapp/public/leaflet/leaflet.css");
const LEAFLET_JS: &str = include_str!("../../swapp/public/leaflet/leaflet.js");

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

#[get("/leaflet/leaflet.css")]
pub async fn leaflet_css() -> impl Responder {
    HttpResponse::Ok()
        .content_type("text/css; charset=utf-8")
        .body(LEAFLET_CSS)
}

#[get("/leaflet/leaflet.js")]
pub async fn leaflet_js() -> impl Responder {
    HttpResponse::Ok()
        .content_type("text/javascript; charset=utf-8")
        .body(LEAFLET_JS)
}

const INDEX_HTML: &str = r#"<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MESSENGERS</title>
  <link rel="stylesheet" href="leaflet/leaflet.css" />
  <style>
    .leaflet-bar a,
    .leaflet-control-layers {
      border-color: #3f3f46;
      background: #18181b;
      color: #e4e4e7;
    }
    .leaflet-bar a:hover,
    .leaflet-bar a:focus {
      border-color: #52525b;
      background: #27272a;
      color: #fafafa;
    }
    .leaflet-control-attribution {
      background: #18181be6 !important;
      color: #a1a1aa;
    }
    .leaflet-control-attribution a {
      color: #7dd3fc;
    }
  </style>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="leaflet/leaflet.js"></script>
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
      <button id="polygonsTabBtn" class="border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100" type="button">Райони Інтересу</button>
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
            <input id="phoneInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" type="tel" inputmode="tel" autocomplete="tel" placeholder="+380501234567" aria-describedby="phoneHint phoneError" required />
            <span id="phoneHint" class="text-xs text-zinc-500">Формат: +380XXXXXXXXX або 0XXXXXXXXX; пробіли можна використовувати.</span>
            <span id="phoneError" class="hidden text-xs text-red-400" role="alert"></span>
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
          Автоматизація пересилає нові повідомлення з вибраної групи у цільову. Можна обмежити пересилання ключовими словами, частотами, координатами, районом інтересу та віком повідомлення.
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
              <option value="any" style="color:#71717a">--</option>
              <option value="skip_with_coordinates">Ігнорувати повідомлення із координатами</option>
              <option value="skip_without_coordinates">Ігнорувати повідомлення без координат</option>
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Район Інтересу</span>
            <select id="polygonInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500"></select>
          </label>
          <div id="polygonFilterFields" class="hidden grid gap-3">
            <label class="grid gap-1 text-sm">
              <span class="text-zinc-400">Режим району інтересу</span>
              <select id="polygonModeInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
                <option value="none" style="color:#71717a">Не фільтрувати</option>
                <option value="inside">Ігнорувати всередині</option>
                <option value="outside">Ігнорувати зовні</option>
              </select>
            </label>
          </div>
          <label class="flex items-center gap-2 text-sm text-zinc-300">
            <input id="coordinatesScreenshotInput" type="checkbox" class="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
            Додавати скріншот з координатами
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

    <section id="polygonsTab" class="hidden grid gap-4">
      <form id="polygonForm" class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-4">
        <h2 class="text-base font-medium">Новий район інтересу</h2>
        <div class="mt-4 grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div class="grid content-start gap-3">
            <label class="grid gap-1 text-sm">
              <span class="text-zinc-400">Назва</span>
              <input id="polygonNameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="Північний фланг" required />
            </label>
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm text-zinc-400">Точки району</span>
              <span id="polygonPointCount" class="text-xs text-zinc-500">0 точок</span>
            </div>
            <div id="polygonPointList" class="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2"></div>
            <div class="flex gap-2">
              <button id="polygonAddPointBtn" class="h-10 flex-1 rounded-md border border-sky-600 px-3 text-sm text-sky-300 hover:bg-sky-950/50" type="button">Додати точку</button>
              <button id="polygonClearPointsBtn" class="h-10 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900" type="button">Очистити</button>
            </div>
            <div class="grid grid-cols-[1fr_1fr_auto] gap-2">
              <label>
                <span class="sr-only">Широта</span>
                <input id="polygonLatitudeInput" class="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-sky-500" type="number" min="-90" max="90" step="any" inputmode="decimal" placeholder="Широта" />
              </label>
              <label>
                <span class="sr-only">Довгота</span>
                <input id="polygonLongitudeInput" class="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-sky-500" type="number" step="any" inputmode="decimal" placeholder="Довгота" />
              </label>
              <button id="polygonAddCoordinatesBtn" class="h-10 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900" type="button">Додати</button>
            </div>
            <p class="text-xs text-zinc-500">Виберіть точку на карті або введіть широту й довготу. Додані точки можна перетягувати. Для району потрібно щонайменше 3 точки.</p>
            <p id="polygonGeometryWarning" class="hidden rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300" role="alert"></p>
            <details class="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
              <summary class="cursor-pointer text-xs text-zinc-400">Вставити список координат</summary>
              <label class="mt-2 grid gap-1 text-xs text-zinc-500">
                <span>Одна точка в рядку; підтримуються MGRS та десяткові координати. Зміни на карті замінять цей список.</span>
                <textarea id="polygonCoordinatesInput" class="min-h-28 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500" placeholder="37U DR 05997 22279&#10;37U DR 06020 22340&#10;37U DR 06090 22270"></textarea>
              </label>
            </details>
            <button class="mt-2 h-10 rounded-md bg-sky-500 px-4 text-sm font-medium text-zinc-950 hover:bg-sky-400" type="submit">Створити</button>
            <p id="polygonFormMsg" class="min-h-5 text-sm text-zinc-400"></p>
          </div>
          <div id="polygonMap" class="h-[420px] min-h-72 overflow-hidden rounded-md border border-zinc-700 bg-zinc-950" aria-label="Карта нового району інтересу"></div>
        </div>
      </form>

      <section class="rounded-lg border border-zinc-800 bg-zinc-900/50">
        <div class="border-b border-zinc-800 px-4 py-3">
          <h2 class="text-base font-medium">Райони Інтересу</h2>
        </div>
        <div id="polygonList" class="grid gap-3 p-4"></div>
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

  <dialog id="automationEditDialog" class="w-[min(92vw,520px)] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-100 backdrop:bg-black/70">
    <form id="automationEditForm">
      <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 class="text-base font-medium">Редагувати автоматизацію</h2>
        <button id="closeAutomationEdit" class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" type="button" aria-label="Закрити" title="Закрити">×</button>
      </div>
      <div class="grid max-h-[75vh] gap-3 overflow-y-auto p-4">
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Назва</span>
          <input id="editAutomationNameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="Висновки 3 АК" />
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Акаунт читання</span>
          <select id="editSourceAccountInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Група-джерело</span>
          <select id="editSourceGroupInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Акаунт надсилання</span>
          <select id="editTargetAccountInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Група-призначення</span>
          <select id="editTargetGroupInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required></select>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Ключові слова</span>
          <input id="editKeywordTokenInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="слово, Enter" />
          <div id="editKeywordTokens" class="flex min-h-7 flex-wrap gap-1"></div>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Частоти</span>
          <input id="editFrequencyTokenInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" placeholder="149.200, Enter" />
          <div id="editFrequencyTokens" class="flex min-h-7 flex-wrap gap-1"></div>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Ігнорувати повідомлення старші за, хв</span>
          <input id="editStaleMinutesInput" type="number" min="0" value="60" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required />
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Повідомлення із координатами</span>
          <select id="editCoordinatePresenceInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
            <option value="any" style="color:#71717a">--</option>
            <option value="skip_with_coordinates">Ігнорувати повідомлення із координатами</option>
            <option value="skip_without_coordinates">Ігнорувати повідомлення без координат</option>
          </select>
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-zinc-400">Район Інтересу</span>
          <select id="editPolygonInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500"></select>
        </label>
        <div id="editPolygonFilterFields" class="hidden grid gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Режим району інтересу</span>
            <select id="editPolygonModeInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500">
              <option value="none" style="color:#71717a">Не фільтрувати</option>
              <option value="inside">Ігнорувати всередині</option>
              <option value="outside">Ігнорувати зовні</option>
            </select>
          </label>
        </div>
        <label class="flex items-center gap-2 text-sm text-zinc-300">
          <input id="editCoordinatesScreenshotInput" type="checkbox" class="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
          Додавати скріншот з координатами
        </label>
        <label class="flex items-center gap-2 text-sm text-zinc-300">
          <input id="editResendAttachmentsInput" type="checkbox" class="h-4 w-4 rounded border-zinc-700 bg-zinc-950" />
          Пересилати вкладення
        </label>
        <p id="automationEditFormMsg" class="min-h-5 text-sm text-zinc-400"></p>
      </div>
      <div class="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
        <button class="h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-900" type="button" data-edit-cancel>Скасувати</button>
        <button class="h-10 rounded-md bg-sky-500 px-4 text-sm font-medium text-zinc-950 hover:bg-sky-400" type="submit">Зберегти</button>
      </div>
    </form>
  </dialog>


  <dialog id="polygonEditDialog" class="w-[min(94vw,960px)] rounded-lg border border-zinc-800 bg-zinc-950 p-0 text-zinc-100 backdrop:bg-black/70">
    <form id="polygonEditForm">
      <div class="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <h2 class="text-base font-medium">Редагувати район інтересу</h2>
        <button id="closePolygonEdit" class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" type="button" aria-label="Закрити" title="Закрити">×</button>
      </div>
      <div class="grid max-h-[75vh] gap-4 overflow-y-auto p-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div class="grid content-start gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-zinc-400">Назва</span>
            <input id="editPolygonNameInput" class="h-10 rounded-md border border-zinc-700 bg-zinc-950 px-3 text-zinc-100 outline-none focus:border-sky-500" required />
          </label>
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-zinc-400">Точки району</span>
            <span id="editPolygonPointCount" class="text-xs text-zinc-500">0 точок</span>
          </div>
          <div id="editPolygonPointList" class="grid max-h-48 gap-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950 p-2"></div>
          <div class="flex gap-2">
            <button id="editPolygonAddPointBtn" class="h-10 flex-1 rounded-md border border-sky-600 px-3 text-sm text-sky-300 hover:bg-sky-950/50" type="button">Додати точку</button>
            <button id="editPolygonClearPointsBtn" class="h-10 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900" type="button">Очистити</button>
          </div>
          <div class="grid grid-cols-[1fr_1fr_auto] gap-2">
            <label>
              <span class="sr-only">Широта</span>
              <input id="editPolygonLatitudeInput" class="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-sky-500" type="number" min="-90" max="90" step="any" inputmode="decimal" placeholder="Широта" />
            </label>
            <label>
              <span class="sr-only">Довгота</span>
              <input id="editPolygonLongitudeInput" class="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100 outline-none focus:border-sky-500" type="number" step="any" inputmode="decimal" placeholder="Довгота" />
            </label>
            <button id="editPolygonAddCoordinatesBtn" class="h-10 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:bg-zinc-900" type="button">Додати</button>
          </div>
          <p class="text-xs text-zinc-500">Виберіть точку на карті або введіть широту й довготу. Додані точки можна перетягувати.</p>
          <p id="editPolygonGeometryWarning" class="hidden rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300" role="alert"></p>
          <details class="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
            <summary class="cursor-pointer text-xs text-zinc-400">Редагувати список координат</summary>
            <label class="mt-2 grid gap-1 text-xs text-zinc-500">
              <span>Одна точка в рядку; підтримуються MGRS та десяткові координати. Зміни на карті замінять цей список.</span>
              <textarea id="editPolygonCoordinatesInput" class="min-h-28 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"></textarea>
            </label>
          </details>
          <p id="polygonEditFormMsg" class="min-h-5 text-sm text-zinc-400"></p>
        </div>
        <div id="editPolygonMap" class="h-[460px] min-h-72 overflow-hidden rounded-md border border-zinc-700 bg-zinc-950" aria-label="Карта редагування району інтересу"></div>
      </div>
      <div class="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
        <button class="h-10 rounded-md border border-zinc-700 px-4 text-sm text-zinc-200 hover:bg-zinc-900" type="button" data-polygon-edit-cancel>Скасувати</button>
        <button class="h-10 rounded-md bg-sky-500 px-4 text-sm font-medium text-zinc-950 hover:bg-sky-400" type="submit">Зберегти</button>
      </div>
    </form>
  </dialog>

  <script>
    const list = document.getElementById('list');
    const automationList = document.getElementById('automationList');
    const polygonList = document.getElementById('polygonList');
    const formMsg = document.getElementById('formMsg');
    const automationFormMsg = document.getElementById('automationFormMsg');
    const polygonFormMsg = document.getElementById('polygonFormMsg');
    const automationEditDialog = document.getElementById('automationEditDialog');
    const automationEditFormMsg = document.getElementById('automationEditFormMsg');
    const polygonEditDialog = document.getElementById('polygonEditDialog');
    const polygonEditFormMsg = document.getElementById('polygonEditFormMsg');
    const phoneInput = document.getElementById('phoneInput');
    const phoneError = document.getElementById('phoneError');
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
    let messengers = [];
    let automations = [];
    let automationAccounts = [];
    let automationGroups = [];
    let polygons = [];
    let polygonPreviewMaps = [];
    let polygonPreviewObserver = null;
    let editPolygonId = null;
    const keywordTokens = [];
    const frequencyTokens = [];
    let editAutomationId = null;
    const editKeywordTokens = [];
    const editFrequencyTokens = [];

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

    function normalizedPhone(value) {
      const phone = value.replace(/\s/g, '');
      if (/^0\d{9}$/.test(phone)) return `+38${phone}`;
      if (/^\+380\d{9}$/.test(phone)) return phone;
      return null;
    }

    function phoneValidationError(value) {
      if (value.trim() === '') return 'Вкажіть номер телефону.';
      if (/[^+\d\s]/.test(value)) {
        return 'Використовуйте лише цифри, пробіли та початковий знак «+».';
      }
      return 'Введіть український номер як +380XXXXXXXXX або 0XXXXXXXXX.';
    }

    function validatePhoneInput({ report = false } = {}) {
      const phone = normalizedPhone(phoneInput.value);
      const error = phone ? '' : phoneValidationError(phoneInput.value);
      phoneInput.setCustomValidity(error);
      phoneInput.setAttribute('aria-invalid', error === '' ? 'false' : 'true');
      phoneError.textContent = error;
      phoneError.classList.toggle('hidden', error === '');
      if (phone) phoneInput.value = phone;
      if (report && error) phoneInput.reportValidity();
      return phone;
    }

    function clearPhoneValidation() {
      phoneInput.setCustomValidity('');
      phoneInput.setAttribute('aria-invalid', 'false');
      phoneError.textContent = '';
      phoneError.classList.add('hidden');
    }

    async function load() {
      await loadGlobalPause();
      await loadAutomationAccounts();
      await loadAutomationGroups();
      await loadPolygons();
      await loadAutomations();
      list.innerHTML = '<div class="p-4 text-sm text-zinc-400">Завантаження...</div>';
      try {
        const data = await request(appUrl('/ui-api/messengers'));
        messengers = data;
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
      document.getElementById('polygonsTab').classList.toggle('hidden', tab !== 'polygons');
      document.getElementById('integrationsTabBtn').className = tab === 'integrations'
        ? 'border-b-2 border-sky-400 px-3 py-2 text-sm text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100';
      document.getElementById('automationsTabBtn').className = tab === 'automations'
        ? 'border-b-2 border-sky-400 px-3 py-2 text-sm text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100';
      document.getElementById('polygonsTabBtn').className = tab === 'polygons'
        ? 'border-b-2 border-sky-400 px-3 py-2 text-sm text-zinc-100'
        : 'border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 hover:text-zinc-100';
      if (tab === 'polygons') {
        polygonPointPicker.ensureMap();
        requestAnimationFrame(() => {
          polygonPointPicker.map.invalidateSize();
          polygonPreviewMaps.forEach(preview => {
            preview.map.invalidateSize();
            fitMapToPoints(preview.map, preview.points);
          });
        });
      }
    }

    async function loadAutomationGroups() {
      automationGroups = await request(appUrl('/ui-api/automation-groups'));
      renderAutomationFormSelects();
    }

    async function loadAutomationAccounts() {
      automationAccounts = await request(appUrl('/ui-api/automation-accounts'));
      renderAutomationFormSelects();
    }


    async function loadPolygons() {
      destroyPolygonPreviewMaps();
      polygonList.innerHTML = '<div class="p-4 text-sm text-zinc-400">Завантаження...</div>';
      try {
        const data = await request(appUrl('/ui-api/polygons'));
        polygons = data;
        renderPolygonSelect(document.getElementById('polygonInput'));
        renderPolygonSelect(document.getElementById('editPolygonInput'));
        updatePolygonAvailability();
        updateEditPolygonAvailability();
        if (data.length === 0) {
          polygonList.innerHTML = '<div class="p-4 text-sm text-zinc-400">Районів інтересу ще немає.</div>';
          return;
        }
        polygonList.innerHTML = '';
        data.forEach(renderPolygonRow);
      } catch (err) {
        polygonList.innerHTML = `<div class="p-4 text-sm text-red-400">${err.message}</div>`;
      }
    }

    async function loadAutomations() {
      automationList.innerHTML = '<div class="p-4 text-sm text-zinc-400">Завантаження...</div>';
      try {
        const data = await request(appUrl('/ui-api/automations'));
        automations = data;
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
      select.innerHTML = '<option value="" disabled style="color:#71717a">Оберіть акаунт</option>' + automationAccounts.map(account => {
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
      select.innerHTML = '<option value="" disabled style="color:#71717a">Оберіть групу</option>' + groups.map(group => {
        return `<option value="${group.id}">${group.name} · ${group.messengerName}</option>`;
      }).join('');
      if (groups.some(group => String(group.id) === current)) {
        select.value = current;
      } else if (groups.length > 0) {
        select.value = String(groups[0].id);
      }
    }


    function renderPolygonSelect(select) {
      if (!select) return;
      const current = Number(select.value);
      select.innerHTML = '<option value="" style="color:#71717a">Оберіть район</option>' + polygons.map(polygon => {
        return `<option value="${polygon.id}">${polygon.name}</option>`;
      }).join('');
      if (polygons.some(polygon => polygon.id === current)) {
        select.value = String(current);
      }
    }

    function polygonIdValue(selectId) {
      const value = Number(document.getElementById(selectId).value);
      return polygons.some(polygon => polygon.id === value) ? value : null;
    }

    const defaultMapCenter = [47.42135, 35.62197];
    const defaultMapZoom = 8;

    function pointCountLabel(count) {
      const lastTwo = count % 100;
      const last = count % 10;
      if (lastTwo >= 11 && lastTwo <= 14) return `${count} точок`;
      if (last === 1) return `${count} точка`;
      if (last >= 2 && last <= 4) return `${count} точки`;
      return `${count} точок`;
    }

    function formatCoordinate(point) {
      return `${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}`;
    }

    function coordinateValues(points) {
      return points.map(point => point.coordinate ?? formatCoordinate(point));
    }

    function splitCoordinateLines(value) {
      return value
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    }

    function coordinateLines(inputId) {
      return splitCoordinateLines(document.getElementById(inputId).value);
    }

    function polygonSidesAreAdjacent(firstSide, secondSide, pointCount) {
      return (firstSide + 1) % pointCount === secondSide
        || (secondSide + 1) % pointCount === firstSide;
    }

    function crossProduct(start, end, point) {
      return (end.lng - start.lng) * (point.lat - start.lat)
        - (end.lat - start.lat) * (point.lng - start.lng);
    }

    function pointIsOnSegment(point, start, end) {
      return point.lng >= Math.min(start.lng, end.lng)
        && point.lng <= Math.max(start.lng, end.lng)
        && point.lat >= Math.min(start.lat, end.lat)
        && point.lat <= Math.max(start.lat, end.lat);
    }

    function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
      const firstStartSide = crossProduct(firstStart, firstEnd, secondStart);
      const firstEndSide = crossProduct(firstStart, firstEnd, secondEnd);
      const secondStartSide = crossProduct(secondStart, secondEnd, firstStart);
      const secondEndSide = crossProduct(secondStart, secondEnd, firstEnd);
      if (firstStartSide === 0 && pointIsOnSegment(secondStart, firstStart, firstEnd)) return true;
      if (firstEndSide === 0 && pointIsOnSegment(secondEnd, firstStart, firstEnd)) return true;
      if (secondStartSide === 0 && pointIsOnSegment(firstStart, secondStart, secondEnd)) return true;
      if (secondEndSide === 0 && pointIsOnSegment(firstEnd, secondStart, secondEnd)) return true;
      return Math.sign(firstStartSide) !== Math.sign(firstEndSide)
        && Math.sign(secondStartSide) !== Math.sign(secondEndSide);
    }

    function polygonHasCrossingSides(points) {
      for (let firstSide = 0; firstSide < points.length; firstSide += 1) {
        for (let secondSide = firstSide + 1; secondSide < points.length; secondSide += 1) {
          if (polygonSidesAreAdjacent(firstSide, secondSide, points.length)) continue;
          if (segmentsIntersect(
            points[firstSide],
            points[(firstSide + 1) % points.length],
            points[secondSide],
            points[(secondSide + 1) % points.length],
          )) return true;
        }
      }
      return false;
    }

    function polygonGeometryError(points) {
      return polygonHasCrossingSides(points)
        ? 'Сторони району перетинаються. Змініть порядок або розташування точок.'
        : null;
    }

    function pointPickerGeometryError(picker, coordinates = null) {
      const inputCoordinates = coordinates ?? splitCoordinateLines(picker.elements.coordinatesInput.value);
      const mapCoordinates = coordinateValues(picker.points);
      const coordinatesMatch = inputCoordinates.length === mapCoordinates.length
        && inputCoordinates.every((coordinate, index) => coordinate === mapCoordinates[index]);
      return coordinatesMatch ? polygonGeometryError(picker.points) : null;
    }

    function normalizePoint(point, coordinate = null) {
      const latLng = L.latLng(Number(point.lat), Number(point.lng)).wrap();
      return { lat: latLng.lat, lng: latLng.lng, coordinate };
    }

    function createMapTileLayers() {
      return {
        openStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 17,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }),
        satellite: L.tileLayer('https://{s}.google.com/vt/lyrs=s,h&x={x}&y={y}&z={z}&hl=uk', {
          maxZoom: 17,
          subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
          attribution: '&copy; <a href="https://www.google.com/maps">Google</a>',
        }),
      };
    }

    function addMapTileLayers(map, showControl) {
      const tileLayers = createMapTileLayers();
      tileLayers.satellite.addTo(map);
      if (showControl) {
        L.control.layers(
          {
            'Супутник': tileLayers.satellite,
            'OpenStreetMap': tileLayers.openStreetMap,
          },
          null,
          { collapsed: false },
        ).addTo(map);
      }
    }

    function pointMarkerIcon(index) {
      return L.divIcon({
        className: '',
        html: `<span style="display:grid;width:28px;height:28px;place-items:center;border:2px solid #f8fafc;border-radius:9999px;background:#f59e0b;color:#18181b;font-size:12px;font-weight:700;box-shadow:0 1px 4px #0008">${index + 1}</span>`,
        iconAnchor: [14, 14],
        iconSize: [28, 28],
      });
    }

    function drawArea(layerGroup, points, onPointMoved = null) {
      layerGroup.clearLayers();
      const latLngs = points.map(point => [point.lat, point.lng]);
      if (points.length >= 3) {
        const hasCrossingSides = polygonHasCrossingSides(points);
        L.polygon(latLngs, {
          color: hasCrossingSides ? '#f87171' : '#38bdf8',
          fillColor: hasCrossingSides ? '#dc2626' : '#0ea5e9',
          fillOpacity: 0.24,
          weight: 3,
        }).addTo(layerGroup);
      } else if (points.length === 2) {
        L.polyline(latLngs, { color: '#38bdf8', weight: 3 }).addTo(layerGroup);
      }
      points.forEach((point, index) => {
        if (onPointMoved) {
          L.marker([point.lat, point.lng], {
            draggable: true,
            icon: pointMarkerIcon(index),
            title: `Точка ${index + 1}. Перетягніть, щоб змінити`,
          }).on('dragend', event => onPointMoved(index, event.target.getLatLng())).addTo(layerGroup);
        } else {
          L.circleMarker([point.lat, point.lng], {
            color: '#f8fafc',
            fillColor: '#f59e0b',
            fillOpacity: 1,
            radius: 6,
            weight: 2,
          }).addTo(layerGroup);
        }
      });
    }

    function fitMapToPoints(map, points) {
      if (points.length === 0) {
        map.setView(defaultMapCenter, defaultMapZoom);
      } else if (points.length === 1) {
        map.setView([points[0].lat, points[0].lng], 14);
      } else {
        map.fitBounds(points.map(point => [point.lat, point.lng]), {
          maxZoom: 15,
          padding: [28, 28],
        });
      }
    }

    function renderPointPicker(picker) {
      const { addButton, geometryWarning, mapContainer, pointCount, pointList } = picker.elements;
      pointCount.textContent = pointCountLabel(picker.points.length);
      pointList.innerHTML = picker.points.length === 0
        ? '<p class="px-1 py-2 text-xs text-zinc-500">Точок ще немає.</p>'
        : picker.points.map((point, index) => `
            <div class="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs hover:bg-zinc-900">
              <span class="truncate text-zinc-300"><span class="mr-2 text-zinc-500">${index + 1}</span>${formatCoordinate(point)}</span>
              <button data-point-index="${index}" class="shrink-0 text-zinc-500 hover:text-red-400" type="button" aria-label="Видалити точку ${index + 1}">×</button>
            </div>
          `).join('');
      addButton.textContent = picker.selecting ? 'Виберіть точку на карті…' : 'Додати точку';
      addButton.className = picker.selecting
        ? 'h-10 flex-1 rounded-md border border-amber-500 bg-amber-950/40 px-3 text-sm text-amber-300'
        : 'h-10 flex-1 rounded-md border border-sky-600 px-3 text-sm text-sky-300 hover:bg-sky-950/50';
      const geometryError = pointPickerGeometryError(picker);
      geometryWarning.textContent = geometryError ?? '';
      geometryWarning.classList.toggle('hidden', geometryError === null);
      mapContainer.style.cursor = picker.selecting ? 'crosshair' : '';
      if (picker.layerGroup) {
        drawArea(picker.layerGroup, picker.points, (index, latLng) => {
          picker.points[index] = normalizePoint(latLng);
          picker.syncCoordinates();
          picker.render();
        });
      }
    }

    function initializePointPickerMap(picker) {
      if (picker.map) return;
      picker.map = L.map(picker.elements.mapContainer, { zoomControl: true })
        .setView(defaultMapCenter, defaultMapZoom);
      addMapTileLayers(picker.map, true);
      picker.layerGroup = L.layerGroup().addTo(picker.map);
      picker.map.on('click', event => {
        if (!picker.selecting) return;
        picker.points.push(normalizePoint(event.latlng));
        picker.selecting = false;
        picker.syncCoordinates();
        picker.render();
      });
      picker.render();
    }

    function addManualPoint(picker) {
      const { latitudeInput, longitudeInput } = picker.elements;
      const lat = Number(latitudeInput.value);
      const lng = Number(longitudeInput.value);
      const latitudeValid = latitudeInput.value !== '' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
      const longitudeValid = longitudeInput.value !== '' && Number.isFinite(lng);
      latitudeInput.setCustomValidity(latitudeValid ? '' : 'Введіть широту від -90 до 90.');
      longitudeInput.setCustomValidity(longitudeValid ? '' : 'Введіть числову довготу.');
      if (!latitudeValid) {
        latitudeInput.reportValidity();
        return;
      }
      if (!longitudeValid) {
        longitudeInput.reportValidity();
        return;
      }
      picker.ensureMap();
      const point = normalizePoint({ lat, lng });
      picker.points.push(point);
      picker.selecting = false;
      latitudeInput.value = '';
      longitudeInput.value = '';
      picker.syncCoordinates();
      picker.render();
      picker.map.setView([point.lat, point.lng], Math.max(picker.map.getZoom(), 14));
    }

    function bindPointPickerEvents(picker) {
      const {
        addButton,
        addCoordinatesButton,
        clearButton,
        coordinatesInput,
        latitudeInput,
        longitudeInput,
        pointList,
      } = picker.elements;
      addButton.addEventListener('click', () => {
        picker.ensureMap();
        picker.selecting = !picker.selecting;
        picker.render();
      });
      addCoordinatesButton.addEventListener('click', () => addManualPoint(picker));
      clearButton.addEventListener('click', () => picker.setPoints([], { fit: false }));
      coordinatesInput.addEventListener('input', () => picker.render());
      pointList.addEventListener('click', event => {
        const button = event.target.closest('button[data-point-index]');
        if (!button) return;
        picker.points.splice(Number(button.dataset.pointIndex), 1);
        picker.syncCoordinates();
        picker.render();
      });
      [latitudeInput, longitudeInput].forEach(input => {
        input.addEventListener('input', () => input.setCustomValidity(''));
        input.addEventListener('keydown', event => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          addManualPoint(picker);
        });
      });
    }

    function createPointPicker({
      mapId,
      addButtonId,
      addCoordinatesButtonId,
      clearButtonId,
      latitudeInputId,
      longitudeInputId,
      coordinatesInputId,
      geometryWarningId,
      listId,
      countId,
    }) {
      const picker = {
        map: null,
        layerGroup: null,
        points: [],
        selecting: false,
        elements: {
          mapContainer: document.getElementById(mapId),
          addButton: document.getElementById(addButtonId),
          addCoordinatesButton: document.getElementById(addCoordinatesButtonId),
          clearButton: document.getElementById(clearButtonId),
          latitudeInput: document.getElementById(latitudeInputId),
          longitudeInput: document.getElementById(longitudeInputId),
          coordinatesInput: document.getElementById(coordinatesInputId),
          geometryWarning: document.getElementById(geometryWarningId),
          pointList: document.getElementById(listId),
          pointCount: document.getElementById(countId),
        },
      };
      picker.render = () => renderPointPicker(picker);
      picker.ensureMap = () => initializePointPickerMap(picker);
      picker.syncCoordinates = () => {
        picker.elements.coordinatesInput.value = coordinateValues(picker.points).join('\n');
      };
      picker.setPoints = (points, { coordinates = [], fit = true } = {}) => {
        picker.elements.latitudeInput.value = '';
        picker.elements.longitudeInput.value = '';
        picker.elements.latitudeInput.setCustomValidity('');
        picker.elements.longitudeInput.setCustomValidity('');
        picker.points = points.map((point, index) => normalizePoint(point, coordinates[index] ?? null));
        picker.selecting = false;
        picker.syncCoordinates();
        picker.render();
        if (fit && picker.map) {
          requestAnimationFrame(() => {
            picker.map.invalidateSize();
            fitMapToPoints(picker.map, picker.points);
          });
        }
      };
      picker.cancelSelection = () => {
        picker.selecting = false;
        picker.render();
      };
      bindPointPickerEvents(picker);
      picker.render();
      return picker;
    }

    function destroyPolygonPreviewMaps() {
      polygonPreviewObserver?.disconnect();
      polygonPreviewObserver = null;
      polygonPreviewMaps.forEach(preview => preview.map.remove());
      polygonPreviewMaps = [];
    }

    function queuePolygonPreview(item) {
      const container = document.getElementById(`polygon-preview-${item.id}`);
      if (!('IntersectionObserver' in window)) {
        renderPolygonPreview(item);
        return;
      }
      if (!polygonPreviewObserver) {
        const observer = new IntersectionObserver(entries => {
          entries.filter(entry => entry.isIntersecting).forEach(entry => {
            observer.unobserve(entry.target);
            const polygon = polygons.find(value => value.id === Number(entry.target.dataset.polygonPreview));
            if (polygon) renderPolygonPreview(polygon);
          });
        }, { rootMargin: '240px 0px' });
        polygonPreviewObserver = observer;
      }
      polygonPreviewObserver.observe(container);
    }

    function renderPolygonPreview(item) {
      const container = document.getElementById(`polygon-preview-${item.id}`);
      if (!container || container.dataset.mapReady === 'true') return;
      container.dataset.mapReady = 'true';
      const map = L.map(container, {
        boxZoom: false,
        doubleClickZoom: false,
        dragging: false,
        keyboard: false,
        scrollWheelZoom: false,
        tap: false,
        touchZoom: false,
        zoomControl: false,
      }).setView(defaultMapCenter, defaultMapZoom);
      addMapTileLayers(map, false);
      const layerGroup = L.layerGroup().addTo(map);
      drawArea(layerGroup, item.points);
      fitMapToPoints(map, item.points);
      map.on('click', () => openPolygonEdit(item.id));
      polygonPreviewMaps.push({ map, points: item.points });
    }

    const polygonPointPicker = createPointPicker({
      mapId: 'polygonMap',
      addButtonId: 'polygonAddPointBtn',
      addCoordinatesButtonId: 'polygonAddCoordinatesBtn',
      clearButtonId: 'polygonClearPointsBtn',
      latitudeInputId: 'polygonLatitudeInput',
      longitudeInputId: 'polygonLongitudeInput',
      coordinatesInputId: 'polygonCoordinatesInput',
      geometryWarningId: 'polygonGeometryWarning',
      listId: 'polygonPointList',
      countId: 'polygonPointCount',
    });
    const editPolygonPointPicker = createPointPicker({
      mapId: 'editPolygonMap',
      addButtonId: 'editPolygonAddPointBtn',
      addCoordinatesButtonId: 'editPolygonAddCoordinatesBtn',
      clearButtonId: 'editPolygonClearPointsBtn',
      latitudeInputId: 'editPolygonLatitudeInput',
      longitudeInputId: 'editPolygonLongitudeInput',
      coordinatesInputId: 'editPolygonCoordinatesInput',
      geometryWarningId: 'editPolygonGeometryWarning',
      listId: 'editPolygonPointList',
      countId: 'editPolygonPointCount',
    });

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

    function replaceTokens(tokens, values) {
      tokens.splice(0, tokens.length, ...values);
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

    function pencilIcon() {
      return `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
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

    function messengerDisplayName(name) {
      const item = messengers.find(messenger => messenger.name === name);
      return item?.displayName || name;
    }

    function renderRow(item) {
      const row = document.createElement('article');
      row.className = 'grid gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-4';
      row.innerHTML = `
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="truncate text-base font-medium">${item.displayName || item.name}</h3>
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

    function automationStatusLabel(item) {
      if (item.isPaused) return 'пауза';
      const labels = {
        idle: 'очікує',
        running: 'обробляє',
        warning: 'попередження',
        error: 'помилка',
      };
      return labels[item.status] || item.status;
    }

    function automationStatusClass(item) {
      if (item.isPaused) return 'text-amber-300';
      if (item.status === 'error') return 'text-red-400';
      if (item.status === 'warning') return 'text-amber-300';
      if (item.status === 'running') return 'text-sky-300';
      return 'text-emerald-400';
    }

    function automationField(label, value) {
      return `
        <p class="mt-1 text-xs text-zinc-400">
          <span class="mr-1 text-zinc-500">${label}:</span>${value || '-'}
        </p>
      `;
    }

    function usageChip(value, label) {
      return `
        <span class="inline-flex items-center gap-1 rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-200">
          <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">${label}</span>
          ${value}
        </span>
      `;
    }


    function renderPolygonRow(item) {
      const row = document.createElement('article');
      row.className = 'grid gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-4';
      row.innerHTML = `
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="truncate text-base font-medium">${item.name}</h3>
              <span class="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">${pointCountLabel(item.points.length)}</span>
              ${item.automationCount > 0 ? `<span class="text-sm text-zinc-400">${item.automationCount} автоматизацій</span>` : ''}
            </div>
          </div>
          <div class="flex shrink-0 gap-2">
            <button data-polygon-edit="${item.id}" class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" type="button" aria-label="Редагувати район інтересу" title="Редагувати район інтересу">${pencilIcon()}</button>
            <button data-polygon-delete="${item.id}" class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-500" type="button" aria-label="Видалити район інтересу" title="Видалити район інтересу">${deleteIcon()}</button>
          </div>
        </div>
        <div id="polygon-preview-${item.id}" data-polygon-preview="${item.id}" class="h-48 cursor-pointer overflow-hidden rounded-md border border-zinc-800 bg-zinc-900" title="Відкрити й редагувати"></div>
      `;
      polygonList.appendChild(row);
      queuePolygonPreview(item);
    }

    function renderAutomationRow(item) {
      const row = document.createElement('article');
      row.className = 'grid gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-4';
      const usage = item.usage || { last24h: 0, last7d: 0, allTime: 0 };
      const checkpoint = item.checkpointAt > 0
        ? new Date(item.checkpointAt).toLocaleString('uk-UA')
        : 'ще не синхронізовано';
      const filters = [...item.keywordTokens, ...item.frequencyTokens].join(', ') || 'Усі повідомлення';
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
              <span class="${automationStatusClass(item)} text-sm">${automationStatusLabel(item)}</span>
            </div>
            <div class="mt-2">
              ${automationField('Звідки', `${item.sourceAccountName} / ${item.sourceGroupName}`)}
              ${automationField('Куди', `${item.targetAccountName} / ${item.targetGroupName}`)}
              ${automationField('Фільтри', filters)}
              ${item.polygonFilterMode !== 'none' ? automationField('Район Інтересу', item.polygonName || '-') : ''}
              ${item.coordinatesScreenshot ? automationField('Скріншот координат', 'увімкнено') : ''}
              ${automationField('Синхронізовано до', checkpoint)}
            </div>
            ${warnings.map(warning => `<p class="mt-1 text-xs text-amber-300">${warning}</p>`).join('')}
            ${item.lastError ? `<p class="mt-1 text-xs text-red-400">${item.lastError}</p>` : ''}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <div class="flex flex-wrap justify-end gap-1">
              ${usageChip(usage.last24h, 'день')}
              ${usageChip(usage.last7d, 'тиждень')}
              ${usageChip(usage.allTime, 'весь час')}
            </div>
            <button data-automation-edit="${item.id}" class="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 text-zinc-200 hover:bg-zinc-900" type="button" aria-label="Редагувати автоматизацію" title="Редагувати автоматизацію">${pencilIcon()}</button>
            <button data-automation-pause="${item.id}" data-paused="${item.isPaused}" class="inline-flex h-9 w-9 items-center justify-center rounded-md border ${item.isPaused ? 'border-amber-700 text-amber-300 hover:bg-amber-950/40' : 'border-zinc-700 text-zinc-200 hover:bg-zinc-900'}" type="button" aria-label="${item.isPaused ? 'Запустити автоматизацію' : 'Зупинити автоматизацію'}" title="${item.isPaused ? 'Запустити автоматизацію' : 'Зупинити автоматизацію'}">${item.isPaused ? playIcon() : pauseIcon()}</button>
            <button data-automation-delete="${item.id}" class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-red-600 text-white hover:bg-red-500" type="button" aria-label="Видалити автоматизацію" title="Видалити автоматизацію">${deleteIcon()}</button>
          </div>
        </div>
      `;
      automationList.appendChild(row);
    }

    function automationPayload() {
      const polygonId = polygonIdValue('polygonInput');
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
        coordinatesScreenshot: document.getElementById('coordinatesScreenshotInput').checked,
        coordinatePresenceMode: document.getElementById('coordinatePresenceInput').value,
        polygonFilterMode: polygonId === null ? 'none' : document.getElementById('polygonModeInput').value,
        polygonId,
      };
    }

    function editAutomationPayload() {
      const polygonId = polygonIdValue('editPolygonInput');
      return {
        name: document.getElementById('editAutomationNameInput').value.trim(),
        sourceAccountId: Number(document.getElementById('editSourceAccountInput').value),
        sourceGroupId: Number(document.getElementById('editSourceGroupInput').value),
        targetAccountId: Number(document.getElementById('editTargetAccountInput').value),
        targetGroupId: Number(document.getElementById('editTargetGroupInput').value),
        keywordTokens: editKeywordTokens,
        frequencyTokens: editFrequencyTokens,
        staleMessageCutoffMinutes: Number(document.getElementById('editStaleMinutesInput').value),
        resendAttachments: document.getElementById('editResendAttachmentsInput').checked,
        coordinatesScreenshot: document.getElementById('editCoordinatesScreenshotInput').checked,
        coordinatePresenceMode: document.getElementById('editCoordinatePresenceInput').value,
        polygonFilterMode: polygonId === null ? 'none' : document.getElementById('editPolygonModeInput').value,
        polygonId,
      };
    }

    function selectOption(selectId, value) {
      const select = document.getElementById(selectId);
      select.value = String(value);
    }

    function openAutomationEdit(id) {
      const item = automations.find(automation => automation.id === Number(id));
      if (!item) return;
      editAutomationId = item.id;
      automationEditFormMsg.textContent = '';
      document.getElementById('editAutomationNameInput').value = item.name || '';
      renderAccountSelect(document.getElementById('editSourceAccountInput'));
      selectOption('editSourceAccountInput', item.sourceAccountId);
      renderGroupSelect(document.getElementById('editSourceGroupInput'), item.sourceAccountId);
      selectOption('editSourceGroupInput', item.sourceGroupId);
      renderAccountSelect(document.getElementById('editTargetAccountInput'));
      selectOption('editTargetAccountInput', item.targetAccountId);
      renderGroupSelect(document.getElementById('editTargetGroupInput'), item.targetAccountId);
      selectOption('editTargetGroupInput', item.targetGroupId);
      replaceTokens(editKeywordTokens, item.keywordTokens);
      replaceTokens(editFrequencyTokens, item.frequencyTokens);
      renderToken('editKeywordTokens', editKeywordTokens, 'edit-keyword');
      renderToken('editFrequencyTokens', editFrequencyTokens, 'edit-frequency');
      document.getElementById('editStaleMinutesInput').value = item.staleMessageCutoffMinutes;
      document.getElementById('editResendAttachmentsInput').checked = item.resendAttachments;
      document.getElementById('editCoordinatesScreenshotInput').checked = item.coordinatesScreenshot;
      document.getElementById('editCoordinatePresenceInput').value = item.coordinatePresenceMode;
      document.getElementById('editPolygonModeInput').value = item.polygonFilterMode;
      renderPolygonSelect(document.getElementById('editPolygonInput'));
      document.getElementById('editPolygonInput').value = item.polygonId ? String(item.polygonId) : '';
      updateEditPolygonAvailability();
      automationEditDialog.showModal();
    }


    function openPolygonEdit(id) {
      const item = polygons.find(polygon => polygon.id === Number(id));
      if (!item) return;
      editPolygonId = item.id;
      polygonEditFormMsg.textContent = '';
      document.getElementById('editPolygonNameInput').value = item.name || '';
      polygonEditDialog.showModal();
      editPolygonPointPicker.ensureMap();
      editPolygonPointPicker.setPoints(item.points, { coordinates: item.coordinates });
    }

    document.getElementById('createForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const phone = validatePhoneInput({ report: true });
      if (!phone) return;
      formMsg.textContent = 'Створення...';
      try {
        await request(appUrl('/ui-api/messengers'), {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('nameInput').value,
            kind: document.getElementById('kindInput').value,
            phone,
          }),
        });
        formMsg.textContent = 'Створено.';
        event.target.reset();
        clearPhoneValidation();
        await load();
      } catch (err) {
        formMsg.textContent = err.message;
      }
    });


    document.getElementById('polygonForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const coordinates = coordinateLines('polygonCoordinatesInput');
      if (coordinates.length < 3) {
        polygonFormMsg.textContent = 'Додайте щонайменше 3 точки.';
        return;
      }
      const geometryError = pointPickerGeometryError(polygonPointPicker, coordinates);
      if (geometryError) {
        polygonFormMsg.textContent = geometryError;
        return;
      }
      polygonFormMsg.textContent = 'Створення...';
      try {
        await request(appUrl('/ui-api/polygons'), {
          method: 'POST',
          body: JSON.stringify({
            name: document.getElementById('polygonNameInput').value.trim(),
            coordinates,
          }),
        });
        polygonFormMsg.textContent = 'Створено.';
        event.target.reset();
        polygonPointPicker.setPoints([], { fit: false });
        await loadPolygons();
      } catch (err) {
        polygonFormMsg.textContent = err.message;
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
        replaceTokens(keywordTokens, []);
        replaceTokens(frequencyTokens, []);
        renderToken('keywordTokens', keywordTokens, 'keyword');
        renderToken('frequencyTokens', frequencyTokens, 'frequency');
        renderAutomationFormSelects();
        renderPolygonSelect(document.getElementById('polygonInput'));
        updatePolygonAvailability();
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

    document.getElementById('editSourceAccountInput').addEventListener('change', () => {
      renderGroupSelect(
        document.getElementById('editSourceGroupInput'),
        Number(document.getElementById('editSourceAccountInput').value),
      );
    });

    document.getElementById('editTargetAccountInput').addEventListener('change', () => {
      renderGroupSelect(
        document.getElementById('editTargetGroupInput'),
        Number(document.getElementById('editTargetAccountInput').value),
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

    document.getElementById('editKeywordTokens').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button?.dataset.editKeywordToken) return;
      editKeywordTokens.splice(Number(button.dataset.editKeywordToken), 1);
      renderToken('editKeywordTokens', editKeywordTokens, 'edit-keyword');
    });

    document.getElementById('editFrequencyTokens').addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button?.dataset.editFrequencyToken) return;
      editFrequencyTokens.splice(Number(button.dataset.editFrequencyToken), 1);
      renderToken('editFrequencyTokens', editFrequencyTokens, 'edit-frequency');
    });


    polygonList.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const editId = button.dataset.polygonEdit;
      const deleteId = button.dataset.polygonDelete;
      if (editId) {
        openPolygonEdit(editId);
      }
      if (deleteId) {
        if (!confirm('Видалити район інтересу?')) return;
        await request(appUrl(`/ui-api/polygons/${deleteId}`), { method: 'DELETE' });
        await loadPolygons();
        await loadAutomations();
      }
    });

    automationList.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      const editId = button.dataset.automationEdit;
      const pauseId = button.dataset.automationPause;
      const deleteId = button.dataset.automationDelete;
      if (editId) {
        openAutomationEdit(editId);
      }
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
        if (!confirm(`Видалити месенджер ${messengerDisplayName(deleteName)}?`)) return;
        await request(appUrl(`/ui-api/messengers/${deleteName}`), { method: 'DELETE' });
        await load();
      }
      if (unlinkName) {
        if (!confirm(`Відключити месенджер ${messengerDisplayName(unlinkName)}?`)) return;
        await request(appUrl(`/ui-api/messengers/${unlinkName}/unlink`), { method: 'POST' });
        await load();
      }
      if (linkName) openQr(linkName);
    });

    function updatePolygonAvailability() {
      const skipCoordinates = document.getElementById('coordinatePresenceInput').value === 'skip_with_coordinates';
      if (skipCoordinates) {
        document.getElementById('polygonInput').value = '';
        document.getElementById('coordinatesScreenshotInput').checked = false;
      }
      document.getElementById('coordinatesScreenshotInput').disabled = skipCoordinates;
      const noPolygon = polygonIdValue('polygonInput') === null;
      document.getElementById('polygonInput').disabled = skipCoordinates;
      document.getElementById('polygonModeInput').disabled = noPolygon;
      document.getElementById('polygonFilterFields').classList.toggle('hidden', noPolygon);
      if (noPolygon) {
        document.getElementById('polygonModeInput').value = 'none';
      }
    }

    function updateEditPolygonAvailability() {
      const skipCoordinates = document.getElementById('editCoordinatePresenceInput').value === 'skip_with_coordinates';
      if (skipCoordinates) {
        document.getElementById('editPolygonInput').value = '';
        document.getElementById('editCoordinatesScreenshotInput').checked = false;
      }
      document.getElementById('editCoordinatesScreenshotInput').disabled = skipCoordinates;
      const noPolygon = polygonIdValue('editPolygonInput') === null;
      document.getElementById('editPolygonInput').disabled = skipCoordinates;
      document.getElementById('editPolygonModeInput').disabled = noPolygon;
      document.getElementById('editPolygonFilterFields').classList.toggle('hidden', noPolygon);
      if (noPolygon) {
        document.getElementById('editPolygonModeInput').value = 'none';
      }
    }


    document.getElementById('polygonEditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const coordinates = coordinateLines('editPolygonCoordinatesInput');
      if (coordinates.length < 3) {
        polygonEditFormMsg.textContent = 'Додайте щонайменше 3 точки.';
        return;
      }
      const geometryError = pointPickerGeometryError(editPolygonPointPicker, coordinates);
      if (geometryError) {
        polygonEditFormMsg.textContent = geometryError;
        return;
      }
      polygonEditFormMsg.textContent = 'Збереження...';
      try {
        await request(appUrl(`/ui-api/polygons/${editPolygonId}`), {
          method: 'PUT',
          body: JSON.stringify({
            name: document.getElementById('editPolygonNameInput').value.trim(),
            coordinates,
          }),
        });
        polygonEditFormMsg.textContent = 'Збережено.';
        polygonEditDialog.close();
        await loadPolygons();
        await loadAutomations();
      } catch (err) {
        polygonEditFormMsg.textContent = err.message;
      }
    });

    document.getElementById('automationEditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      addToken(document.getElementById('editKeywordTokenInput'), editKeywordTokens, 'editKeywordTokens', 'edit-keyword');
      addToken(document.getElementById('editFrequencyTokenInput'), editFrequencyTokens, 'editFrequencyTokens', 'edit-frequency');
      automationEditFormMsg.textContent = 'Збереження...';
      try {
        await request(appUrl(`/ui-api/automations/${editAutomationId}`), {
          method: 'PUT',
          body: JSON.stringify(editAutomationPayload()),
        });
        automationEditFormMsg.textContent = 'Збережено.';
        automationEditDialog.close();
        await loadAutomations();
      } catch (err) {
        automationEditFormMsg.textContent = err.message;
      }
    });

    document.getElementById('closeAutomationEdit').addEventListener('click', () => automationEditDialog.close());
    document.querySelector('[data-edit-cancel]').addEventListener('click', () => automationEditDialog.close());
    document.getElementById('closePolygonEdit').addEventListener('click', () => polygonEditDialog.close());
    document.querySelector('[data-polygon-edit-cancel]').addEventListener('click', () => polygonEditDialog.close());
    polygonEditDialog.addEventListener('close', () => editPolygonPointPicker.cancelSelection());

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
    document.getElementById('polygonsTabBtn').addEventListener('click', () => setActiveTab('polygons'));
    document.getElementById('coordinatePresenceInput').addEventListener('change', updatePolygonAvailability);
    document.getElementById('polygonInput').addEventListener('change', updatePolygonAvailability);
    document.getElementById('polygonModeInput').addEventListener('change', updatePolygonAvailability);
    document.getElementById('editCoordinatePresenceInput').addEventListener('change', updateEditPolygonAvailability);
    document.getElementById('editPolygonInput').addEventListener('change', updateEditPolygonAvailability);
    document.getElementById('editPolygonModeInput').addEventListener('change', updateEditPolygonAvailability);
    bindTokenInput('keywordTokenInput', keywordTokens, 'keywordTokens', 'keyword');
    bindTokenInput('frequencyTokenInput', frequencyTokens, 'frequencyTokens', 'frequency');
    bindTokenInput('editKeywordTokenInput', editKeywordTokens, 'editKeywordTokens', 'edit-keyword');
    bindTokenInput('editFrequencyTokenInput', editFrequencyTokens, 'editFrequencyTokens', 'edit-frequency');
    phoneInput.addEventListener('input', clearPhoneValidation);
    phoneInput.addEventListener('blur', () => {
      if (phoneInput.value.trim() !== '') validatePhoneInput();
    });
    updatePolygonAvailability();
    updateEditPolygonAvailability();
    load();
  </script>
</body>
</html>"#;
