# Mobile Message Video Implementation Plan

> Остаточне уточнення користувача: повернути мобільну кнопку справжнього fullscreen,
> щоб прибрати панелі браузера. Standard API розгортає документ із нашими контролами;
> на iPhone WebKit відкриває системний відеоплеєр із контролами Apple. При виході
> повертаються наші контроли без скидання позиції. Тап по відео лишається перемикачем
> панелей; острівець навігації залишається над закріпленою нижньою панеллю.
> Ця вимога замінює попереднє уточнення про відсутність fullscreen-кнопки.


> Уточнення користувача від 2026-11-06 замінює Task 3 і попередні варіанти fullscreen:
> кнопки fullscreen та викликів native API немає. Відео автоматично заповнює
> доступний viewport при повороті. Хедер, контроли й навігація накладаються поверх
> відео та разом перемикаються тапом, зокрема на паузі, без зміни відтворення.
> Панелі браузера можуть залишатися видимими; потрібна перевірка фізичних телефонів.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Зручний повноекранний перегляд відео з картки повідомлення в «Аналізі» й «Оперативному» на Android та iPhone, зокрема з телефоном у портретній орієнтації.

**Architecture:** Розширити наявний спільний переглядач, додавши мобільний режим для відео. Зберегти один `<video>` і поточний механізм завантаження; системний fullscreen відкривати для цього самого елемента. Зміни спільних компонентів робити опційними, зі збереженням їхніх поточних defaults.

**Tech Stack:** React 18, TypeScript, MUI 6, чинні CSS/tokens, HTMLMediaElement / Fullscreen API, Vitest, Playwright. Нові бібліотеки не потрібні.

**Spec:** [Поведінка і межі цього плану](#поведінка-і-межі).

## Уточнення після перевірки UI — 2026-11-06

Користувач обрав власні контроли на обох платформах. Це уточнення замінює
початкові вимоги до системного відеоплеєра нижче.

- Повернути `AttachmentPreviewMobileCarouselNav` у спільній нижній смузі;
  прибрати окремі стрілки й дубльований лічильник із відеоконтролів.
- Мобільне відео використовує `MessageCardAttachmentPreviewHeader`, як інші
  вкладення: назва/інформація зліва, дії та закриття справа; overflow лише для
  швидкості відтворення. Це замінює окремий мобільний хедер.
- Розміри кнопок і проміжки в хедері повністю успадковуються зі спільного
  компонента, без локального збільшення до 44 px; 44 px стосується власних
  кнопок керування відтворенням.
- Fullscreen належить діалогу, тому перехід між різними типами вкладень його
  не скидає. Стандартний API розгортає кореневий документ: діалог, портальні
  меню, інформація і сповіщення залишаються в одній fullscreen-поверхні.
- Використовувати ті самі відеоелемент і власні контроли до/після входу;
  кнопка змінюється на «Вийти з повноекранного режиму».
- У fullscreen прибрати хедер повністю й віддати відео весь viewport без
  резервування висоти для навігації. Ті самі carousel/playback кнопки працюють
  поверх відео. Режим не залежить від ширини екрана, зокрема у landscape.
- У fullscreen спільний carousel розміщується в компактному напівпрозорому
  острівці вгорі по центру, без смуги хедера. Знизу — компактне керування:
  один ряд від 480 px, таймлайн над кнопками на вужчих екранах. Єдина
  play/pause кнопка в нижній панелі замінює центральну кнопку.
- Така сама компактна нижня панель застосовується і без fullscreen;
  звичайний переглядач зберігає спільний хедер.
- Не викликати `webkitEnterFullscreen`. На iPhone без стандартного API
  кнопка перемикає headerless viewport-перегляд; вихід/Escape/Back повертає
  звичайний спільний хедер. Додати кнопку fullscreen і до desktop playback.
- Оновити E2E: власні контроли у fullscreen, меню, перемикання вкладень,
  повернення/закриття, пізні Promise та відсутність native WebKit викликів.
- Після RED/GREEN перевірити мобільні/desktop знімки, цільові Vitest і build.

## Global Constraints

- Однакова основна взаємодія на Android Chrome та iPhone Safari; системний плеєр може відрізнятися.
- Портретний режим означає орієнтацію телефона. Перемикання вкладень залишається горизонтальним у межах поточного повідомлення.
- Відео вписується повністю, без обрізання й спотворення; поля навколо горизонтального відео в портретному режимі очікувані.
- Мінімальна зона натискання власних мобільних кнопок відтворення — 44 × 44 CSS px;
  спільний хедер зберігає розміри інших вкладень.
- Не додавати бібліотек, змін backend/API, міграцій, примусового повороту чи блокування орієнтації.
- Не змінювати закриті картки, їхню lazy loading поведінку, порядок фідів, `README.md` або `docs/README.md`.
- Зберегти desktop-керування, інші типи вкладень, режим розвіддонесення й нативний плеєр у «Пристроях».
- Реальні середовища, включно з `echo-staging`, не змінювати в межах виконання цього плану.

## Review Focus

- Свайп, pinch і перетягування таймлайна не повинні перетворюватися на tap або play/pause — Task 2.
- Заблокований autoplay, буферизація та пауза залишають користувачеві доступні кнопки — Task 2.
- Відмова fullscreen та пізні fullscreen-події після закриття не ламають переглядач — Task 3.
- Зміна орієнтації й вихід із fullscreen зберігають той самий відеоелемент та позицію відтворення — Tasks 1, 3.
- Опційні зміни не поширюють мобільну поведінку на «Пристрої», аудіо, зображення й документи — Tasks 1, 4.

## Поведінка і межі

Це план на основі обговорення; конкретні UI-рішення нижче є пропозицією для реалізації.

1. Натискання мініатюри відкриває поточний переглядач на весь доступний viewport, без примусового landscape. Темна медіаповерхня використовує наявний механізм темізації.
2. Відео займає максимально можливу площу зі збереженням пропорцій. Дрібні файли також збільшуються; якість понад оригінальну роздільність не покращується.
3. На мобільному верхня панель, play/pause й нижня панель розміщуються поверх відео. Верх: закриття, назва/лічильник, меню додаткових дій. Низ: таймлайн на всю доступну ширину, час, звук і fullscreen. Швидкість, інформація, завантаження та відкриття оригіналу доступні через меню.
4. Один tap на медіаповерхні показує/приховує керування; play/pause має окрему кнопку. Після 2 секунд відтворення без взаємодії панелі ховаються. На паузі, при loading/error, відкритому меню, фокусі в панелі чи перетягуванні таймлайна — залишаються видимими.
5. Приховані панелі не перехоплюють торкання й не залишають невидимих елементів у Tab-навігації. Є українські accessible names; анімації враховують `prefers-reduced-motion`.
6. Врахувати вирізи й системні індикатори через `env(safe-area-inset-*)`. Використати `100dvh` із `100svh` fallback для мобільного відеорежиму; не змінювати глобальний viewport meta без перевірки його генерації й побічних ефектів.
7. Горизонтальні свайпи та наявна навігація між вкладеннями зберігаються. У цьому обсязі не додаємо вертикальне перегортання або новий swipe-to-dismiss. Після свайпа tap не спрацьовує.
8. Кнопка «На весь екран» окремо відкриває системний fullscreen. Якщо API відсутній, кнопка недоступна з поясненням; основний переглядач залишається придатним до роботи. Відмова API показується через наявні toasts, без підміни помилкою завантаження відео.
9. Вихід із системного fullscreen повертає до відкритого переглядача зі збереженням часу, mute, швидкості та стану playback. Власних кнопок Echo у системному плеєрі не обіцяємо. Орієнтація системного плеєра залежить також від ОС.
10. Текст повідомлення/розвіддонесення зберігає поточну видимість і чернетку. Коли поле відкрите, воно займає власне місце; панелі відео не перекривають редактор і не ховаються під час введення.

### Підстава та альтернативи

- У поточному коді діалог уже має `fullScreen`, але це розмір вікна браузера, а не системний fullscreen.
- `VideoFilePreview.tsx` має лише `maxWidth` / `maxHeight`: у локальній перевірці ролик 96 × 64 залишався 96 × 64 при viewport 375 × 812. Частина кнопок мала зони натискання 28–30 px.
- `VideoFilePreview` також використовується в `device-files/components/DeviceFileMediaPreview.tsx`; спільні layout/header/controls обслуговують інші типи вкладень.
- Основний варіант: власний мобільний переглядач плюс кнопка системного fullscreen. Він зберігає взаємодію Echo й додає можливості ОС.
- Альтернатива: тільки системний плеєр. Менше власного UI, але втрачаємо кероване однакове оформлення та навігацію між вкладеннями всередині fullscreen.
- Джерела: [MDN: requestFullscreen і вимога user activation](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen), [Apple: webkitEnterFullscreen](https://developer.apple.com/documentation/webkitjs/htmlvideoelement/1633500-webkitenterfullscreen), [WebKit: обмеження fullscreen довільних елементів на iPhone](https://bugs.webkit.org/show_bug.cgi?id=328773).

## Task 1: Розмір відео та мобільний контейнер

**Files:**
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoFilePreview.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoAttachmentPreviewRenderer.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/MessageCardAttachmentPreviewDialog.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/MessageCardAttachmentPreviewLayout.tsx`
- Create/Test: `wdintel-web/tests/e2e/message-card-video-mobile.spec.ts`
- Reuse: `wdintel-web/tests/e2e/message-card-media-preview.fixtures.ts`

**Interfaces:** `VideoFilePreview` отримує `fit?: 'intrinsic' | 'contain'`, default `'intrinsic'`. `MessageCardAttachmentPreviewLayout` отримує `mobileVideo?: boolean`, default `false`; його вмикає тільки відеорендерер. Viewport-стилі діалогу обмежити поточним `item.type === 'video'` і чинним breakpoint `theme.breakpoints.down('sm')`; це той самий breakpoint для всього мобільного відеорежиму.

- [ ] Перед кодом визначити issue і development branch за правилами репозиторію: поточна гілка `main` не містить issue. Якщо номера немає, знайти релевантні Ready issues і погодити вибір; не створювати placeholder у changelog і не змінювати base branch самостійно. Для цієї підготовки плану issue не потрібний.
- [ ] Додати E2E `portrait video fills available stage without cropping` для `analysis` та `duty`: viewport 375 × 812, справжній наявний MP4 96 × 64, `readyState >= 2`, відображена ширина більша за 96; пропорція 1.5 з похибкою 0.02; межі відео всередині stage. Запустити й отримати FAIL на поточному коді.
- [ ] Для `fit='contain'` задати `width/height: 100%` та `object-fit: contain`, зберігши zoom/pan transforms. Увімкнути лише для мобільного відеорежиму картки; не змінювати default для Devices і desktop.
- [ ] Додати опційний мобільний layout: панелі поверх stage, dark media surface через theme, `dvh`/fallback і safe-area. Зберегти один DOM-відеоелемент при зміні breakpoint; не створювати окремих mobile/desktop players.
- [ ] Додати сценарій `rotation keeps the active video`: 375 × 812 → 812 × 375 → 375 × 812, той самий element/src, playback не скидається до 0. Розміри перевіряти після стабілізації layout; screenshots робити з `animations: 'disabled'`.
- [ ] Run: `cd wdintel-web && npm exec -- playwright test message-card-video-mobile.spec.ts --project=chromium`; очікується PASS для обох hosts.

## Task 2: Мобільні панелі, tap і доступність

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoAttachmentPreviewMobileControls.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoAttachmentPreviewRenderer.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoFilePreview.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/MessageCardAttachmentPreviewLayout.tsx`
- Test: `wdintel-web/tests/e2e/message-card-video-mobile.spec.ts`
- Test: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/__tests__/VideoAttachmentPreviewRenderer.spec.tsx`

**Interfaces:** Новий mobile controls component приймає `playerState: VideoPlayerState`, `visible: boolean`, `navigation: MessageCardPreviewNavigation`, чинні callbacks відтворення/seek/mute/rate/close і `additionalActions: ReactNode` для наявних file/report дій. `VideoFilePreview` отримує `onSurfaceTap?: () => void`; коли callback передано, валідний tap викликає його замість toggle playback. `nativeControls` має пріоритет і зберігає власну поведінку.

- [ ] Додати E2E `tap reveals controls without pausing playback`: після 2 секунд керування сховане; tap показує його, `paused === false`; окрема кнопка паузи зупиняє playback і залишає керування видимим. Спочатку підтвердити FAIL.
- [ ] Зібрати mobile controls зі встановлених MUI-компонентів та поточних callbacks, без дублювання player state. У меню повторно використати існуючі дії; не змінювати desktop controls та спільні audio controls. Мобільний лічильник і навігація не повинні дублювати стару нижню смугу.
- [ ] Оновити наявний двосекундний таймер renderer: скидання при взаємодії; блокування приховування на pause/loading/error, focus, drag, відкритих child overlays і під час введення в report field; очищення таймера при зміні файла/unmount. Для loading передати з `VideoFilePreview` опційний `onBufferingChange?: (buffering: boolean) => void`.
- [ ] Відрізняти tap від swipe/pinch за реальними pointer/touch рухами, повторно використовуючи чинний поріг drag. Не робити `preventDefault` для всіх touch-подій; залишити горизонтальні свайпи, pinch і таймлайн працездатними. Не змінювати загальну семантику `useAttachmentPreviewSwipe`.
- [ ] Додати E2E `swipe and timeline drag do not toggle controls or playback`: справжні touch-послідовності; swipe переходить на наступне вкладення один раз; drag таймлайна змінює час без навігації. Перевірити також pinch без випадкового tap.
- [ ] Додати E2E `visible controls remain operable at 320px`: кнопки >= 44 × 44, немає горизонтального overflow, приховані панелі відсутні в Tab-порядку, focus/menu не зникають за таймером. Іконки мають українські accessible names; при reduced motion анімації вимкнені.
- [ ] У наявному renderer spec доповнити сценарій blocked autoplay: кнопка «Торкніться, щоб відтворити» залишається доступною, таймер її не ховає; перевірити retry після media error.
- [ ] Run: `cd wdintel-web && npm exec -- vitest run src/ts/react/routes/shared/message-card/renderers/__tests__/VideoAttachmentPreviewRenderer.spec.tsx`, потім mobile E2E з Task 1; очікується PASS.

## Task 3: Системний fullscreen і повернення

**Files:**
- Create: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/use-video-fullscreen.ts`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoAttachmentPreviewRenderer.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/VideoAttachmentPreviewMobileControls.tsx`
- Modify: `wdintel-web/src/ts/react/routes/shared/message-card/attachment-preview/MessageCardAttachmentPreviewDialog.tsx`
- Test: `wdintel-web/src/ts/react/routes/shared/message-card/renderers/__tests__/VideoAttachmentPreviewRenderer.spec.tsx`
- Test: `wdintel-web/tests/e2e/message-card-video-mobile.spec.ts`

**Interfaces:** `useVideoFullscreen({ videoRef, onError }: { videoRef: React.RefObject<HTMLVideoElement>; onError: (error: unknown) => void })` повертає `{ supported: boolean; active: boolean; enter: () => void; exit: () => void }`. Mobile controls отримують `fullscreenSupported: boolean`, `fullscreenReady: boolean`, `onFullscreen: () => void`. Готовність визначає renderer після metadata. Передати `active` у наявний `VideoFilePreview.nativeControls`, не створюючи нового video.

- [ ] У renderer spec додати поведінкові регресії: `enters standard video fullscreen`, `uses WebKit video fullscreen when standard API is absent`, `fullscreen rejection keeps preview usable`, `late fullscreen completion after unmount is ignored`. Mock застосовувати тільки до відсутніх browser APIs, перевіряти видимий результат і lifecycle, а не кількість внутрішніх setState.
- [ ] Реалізувати feature detection, без user-agent sniffing: стандартний `video.requestFullscreen()` з перевіркою доступності; за відсутності стандартного API — `webkitEnterFullscreen()`. Викликати синхронно з user gesture, без попереднього await fetch/play. Недоступність API та metadata показувати зрозуміло; не запускати автоматичний fullscreen після завантаження.
- [ ] Стан синхронізувати через `fullscreenchange` та WebKit `webkitbeginfullscreen` / `webkitendfullscreen`, обробляти rejection/throw. На час системного fullscreen забезпечити native controls; після виходу повернути попередній режим без зміни src, часу, mute або rate. До підтвердження входу не залишати custom playback UI недоступним.
- [ ] Помилку входу показати чинним механізмом toasts із текстом «Не вдалося відкрити відео на весь екран». Залишити звичайний переглядач відкритим. При закритті/unmount прибрати listeners, захиститися від пізніх async completion і звільнити тільки fullscreen поточного відео, а не стороннього елемента.
- [ ] Узгодити Escape/Back із поточним dialog keydown та `useBrowserBackOverlay`: у системному fullscreen вихід не повинен одночасно закривати переглядач. Після повернення наступний Back/Close використовує чинний overlay lifecycle; дитячі меню зберігають пріоритет закриття. Не додавати другий history layer для fullscreen.
- [ ] Додати Chromium E2E `native fullscreen preserves playback on exit`: справжній click → `document.fullscreenElement === video`; вихід → dialog відкритий, той самий video/src, час не скинувся, custom controls повернулись. Окремо перевірити unavailable/rejected API і закриття під час pending request. WebKit mocks не вважати перевіркою iPhone.
- [ ] Запустити renderer Vitest і mobile E2E з попередніх задач; очікується PASS. Реальний Android/iPhone fullscreen перевірити за Task 4.

## Task 4: Інтеграція, перевірки та передача

**Files:**
- Test: `wdintel-web/tests/e2e/message-card-video-mobile.spec.ts`
- Existing regression suites: `wdintel-web/tests/e2e/message-card-media-preview.spec.ts`, `wdintel-web/tests/e2e/device-file-preview-media.spec.ts`
- Update focused behavior documentation: `docs/messenger-media-delivery.md`
- Update release notes during implementation: `CHANGELOG.md`, після визначення issue.

**Interfaces:** Усі попередні задачі об'єднані; зовнішні API та generated bindings не змінені.

- [ ] Перевірити mobile E2E для обох hosts на 320 × 640, 375 × 812, 390 × 844 та landscape 812 × 375; desktop 1440 × 900. Використовувати реальні media bytes, не текст під MIME `video/mp4`. Для портретного файла створити в test temp directory MP4 через наявний ffmpeg, повернувши наявний fixture (`-vf transpose=1`); cleanup після тесту, не додавати нової бібліотеки.
- [ ] У новому spec перевірити editing/report mode: відкрите поле й екранна клавіатура не перекривають controls, текст зберігається після fullscreen/виходу. Автоматично перевірити draft persistence; реальну системну клавіатуру — на телефонах.
- [ ] Виконати наявні media-preview та device-video регресії; перевірити desktop play/pause, zoom, mixed carousel, info/download, audio та document previews. Не видаляти сильніші Vitest-перевірки заради E2E.
- [ ] Обов'язково перевірити фізичні Android Chrome та iPhone Safari: портретний перегляд, приховування/повернення browser bars, safe areas, portrait/landscape, native fullscreen/return, системний Back/Done, autoplay із аудіо, повторне відкриття й клавіатуру report field. Зафіксувати ОС/браузер та результати; до цього чесно вказувати, що є лише емуляція. Не обіцяти ідентичний native UI або керовану вебсторінкою орієнтацію системного плеєра.
- [ ] Візуальна перевірка Product Design / Impeccable: один пакет screenshots mobile+desktop, один пакет виправлень і максимум одна підтверджувальна перевірка; окремо порівняти світлу/темну тему. Перед UI-змінами прочитати Impeccable `reference/craft-floor.md`; після завершення один раз виконати його detector для змінених UI-файлів.
- [ ] Відформатувати тільки змінені frontend-файли згідно з `AGENTS.md`: `cd wdintel-web && npm run format:staged`; перевірити diff на сторонні formatter-зміни.
- [ ] Run from repo root: `just test-fe` та `just build-front`; потім `cd wdintel-web && npm exec -- playwright test message-card-video-mobile.spec.ts message-card-media-preview.spec.ts device-file-preview-media.spec.ts --project=chromium`. Усі потрібні перевірки мають завершитись успішно; перелік тестів або mocks native API не замінюють виконання.
- [ ] Оновити focused documentation та issue-linked NEXT changelog за `.github/skills/changelog-next-update/SKILL.md`. Передати screenshots, результати перевірок, відомі device gaps та зміни на review за `CODE_REVIEW.md`.
- [ ] Якщо `.env` містить `MATTERMOST_NOTIFICATION_HOOK`, надіслати одне повідомлення про завершення відповідної роботи через чинний `just notify`; не виводити URL webhook. На момент підготовки цього плану кореневого `.env` немає.

## Критерій готовності

На Android та iPhone користувач відкриває відео в портретній орієнтації, бачить його максимально великим без crop, може керувати відтворенням і горизонтально переходити між вкладеннями. Системний fullscreen має безпечне повернення й не скидає відтворення. Інші переглядачі зберігають поведінку; автоматичні та фізичні device-перевірки виконані. Якщо фізичні телефони недоступні, статус — «реалізовано локально, перевірка на пристроях очікує», без твердження про підтверджену підтримку обох платформ.
