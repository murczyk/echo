# Фонова фіналізація Device uploads

Після звичайного TUS upload клієнт може окремо замовити фонову фіналізацію файлу або аудіо. `202 queued` підтверджує стійке приймання команди та захист джерела, але ще не означає `has_content`, готове аудіо чи завершену транскрипцію. Без явного `async_finalization: true` працює попередній синхронний API; браузерні потоки залишаються синхронними.

## Передумови та конфігурація

API та `bgworker` повинні використовувати ті самі `wd`/`wd_files`, стійкий `storage_dir`, S3 bucket/prefix і початковий 32-байтовий base64 `s3_config.strongbox_key`. Ключ потрібен і після перезапуску для читання вже записаних об'єктів. Порожній/некоректний ключ, відсутня file-registry DB або стійкий root вимикають нове async-приймання з діагностикою під час запуску.

Підтримується поточна топологія зі спільною локальною файловою системою та працездатними `flock`, rename і fsync. Окремі тимчасові каталоги API/worker, розділені диски або довільна багатохостова/NFS-топологія не є підтриманою заміною спільному root. Не видаляйте і не чистіть зовнішніми TTL-скриптами `device-file-content-spool`, `file_upload_tus` чи `device-upload-finalization-slots` усередині `storage_dir`. Джерела, pin-маркери й slot-файли мають переживати перезапуск; локальні кеші можуть бути окремими.

Виконавці файлів та аудіо, звірка, cleanup і облік працюють у процесі `bgworker`; у debug server вони також стартують, якщо не вказано `--no-bgworker`. Live API сам по собі не замінює `bgworker`. Для локальної перевірки запускайте окремо:

```bash
ECHO_CONFIG_PATH=/absolute/private/config.toml target/debug/wdintel-rs --mode=debug server --no-bgworker
ECHO_CONFIG_PATH=/absolute/private/config.toml target/debug/wdintel-rs --mode=debug bgworker
```

Потрібні застосовані міграції обох БД, доступ до Redis/session store, ffmpeg/ffprobe та доступні для читання/запису сховища. Реальний HTTP upload файлів потребує debug/live runtime; `--mode=test` не вмикає цей runtime для окремого сервера.

Новий розділ приватного TOML відсутній за замовчуванням; це означає `enabled = false`:

```toml
[device_upload_finalization]
enabled = false
```

Після підготовки всіх процесів встановіть `enabled = true` на API та worker. Значення читаються під час запуску; зміна TOML потребує перезапуску відповідних процесів. `enabled` керує лише новим прийманням: replay, статус, виконання, звірка та cleanup уже прийнятих job залишаються доступними при `false`.

Невказані параметри мають такі значення:

| Параметри `[device_upload_finalization]` | Значення за замовчуванням |
| --- | --- |
| `file_global_jobs`, `file_actor_jobs` | 512 / 32 |
| `audio_global_jobs`, `audio_actor_jobs` | 512 / 32 |
| `file_global_bytes`, `file_actor_bytes` | 85 899 345 920 / 107 374 182 400 (80 / 100 GiB) |
| `audio_global_bytes`, `audio_actor_bytes` | 8 589 934 592 / 2 147 483 648 (8 / 2 GiB) |
| `file_slots`, `audio_slots`, `decode_slots` | 4 / 4 / 2 |
| `encryption_slots`, `readback_slots` | 2 / 2 **на кожний тип** file/audio |
| `file_unresolved_writes`, `audio_unresolved_writes` | 4 / 4 |
| `poll_seconds`, `lease_seconds`, `heartbeat_seconds` | 1 / 60 / 10 |
| `retry_min_seconds`, `retry_max_seconds` | 1 / 300 |
| `file_phase_seconds`, `audio_phase_seconds` | 1800 / 600 |
| `source_lock_millis`, `shutdown_grace_seconds` | 500 / 120 |

Ліміти slot спільні для sync/async та всіх процесів із цим root. Encryption/readback мають окремі file/audio namespaces: загальна межа кожної операції — удвічі її значення, щоб зайняті file slots не блокували audio. Квоти джерел і невизначених записів розділені за типом. Actor/global квоти застосовуються одночасно, тому менший global byte limit може спрацювати раніше actor limit. Інші чинні TUS, дискові й HTTP rate limits також діють; `enabled = true` їх не скасовує.

`poll_seconds` задає паузу, коли немає готової роботи або сталася помилка отримання/обробки завдання. Після успішно обробленого claim worker одразу бере наступний. Уже прийняті async jobs очікують зайняті slots у межах відповідного `file_phase_seconds`/`audio_phase_seconds`; очікування переривається під час shutdown і не створює нову спробу через короткочасну конкуренцію. Sync-приймання зберігає попередню поведінку при зайнятих slots.

Після фіналізації worker одразу пробує стійко видалити джерело та звільнити квоту. Періодичне відновлення джерел обох типів використовує `poll_seconds`; окреме прибирання файлових S3-спроб зберігає `cleanup_poll_interval_secs`. Збій очищення не скасовує публікацію: квота залишається зарезервованою до підтвердженого звільнення джерела. Завершений job сам по собі ще не означає вільну квоту.

Async-фіналізація перевіряє SHA-256 через наявний OpenSSL, включно з повним читанням записаного об'єкта перед публікацією. Формат хешу, шифрування та перевірки розміру й цілісності залишаються незмінними; прискорення залежить від платформи та збірки OpenSSL.

Для масового клієнта обмежуйте кількість і сумарний розмір одночасно незавершених завантажень. Якщо активна робота, повільне сховище чи збій recovery справді заповнили бюджет, `503` залишається необхідним обмеженням: витримайте `Retry-After` і повторіть ту саму команду для того самого source. Не створюйте заміну upload після невизначеної відповіді. Ліміти варто піднімати лише разом із доступним диском і виміряною пропускною здатністю worker.

Усі числові значення мають бути додатними; `heartbeat_seconds < lease_seconds`, `retry_min_seconds <= retry_max_seconds <= 300`, `source_lock_millis <= 500`, `shutdown_grace_seconds < 135`, byte limits — не більші за `i64::MAX`. Некоректний розділ вимикає нове приймання та використовує безпечні стандартні налаштування для відновлення. Узгоджуйте налаштування всіх процесів; не змінюйте slot limits під час незавершених операцій.

## HTTP: приймання та replay

Завершіть передачу всіх байтів звичайним TUS API. Повний `Upload-Offset` сам по собі не публікує матеріал. У прикладах `COOKIE_JAR` — приватний cookie jar чинної сесії; UUID/URL отримані з попередніх upload-відповідей.

```bash
curl --fail-with-body -b "$COOKIE_JAR" -i \
  -H 'Tus-Resumable: 1.0.0' -H 'Content-Type: application/json' \
  --data '{"async_finalization":true}' \
  "$API_BASE/api/device/file-content-uploads/$FILE_UPLOAD_ID/complete"
```

Для аудіо `upload_url` — відносний URL завершеного upload цього Device, наприклад `/api/device/audio/{device_id}/uploads/{tus_id}.{size}`. Використовуйте початкові ім'я й timestamp при кожному повторі:

```bash
curl --fail-with-body -b "$COOKIE_JAR" -i \
  -H 'Content-Type: application/json' \
  --data-binary @audio-finalization.json \
  "$API_BASE/api/device/audio/receive"
```

Вміст `audio-finalization.json`:

```json
{
  "device_id": "a7874f0b-b05e-4d4c-a652-ec7af9218379",
  "upload_url": "/api/device/audio/a7874f0b-b05e-4d4c-a652-ec7af9218379/uploads/a3a19855-9fc9-4609-8cf3-fd923a093f3b.1048576",
  "name": "recording.wav",
  "recording_started_at": "2026-10-27T10:00:00Z",
  "async_finalization": true
}
```

Нове приймання або повтор неостаточного job повертає:

```http
HTTP/1.1 202 Accepted
Location: /api/device/upload-finalization-jobs/d0b86c10-406c-4aa4-8872-0f83cb18694f
Retry-After: 1
Cache-Control: private, no-store
Content-Type: application/json

{"status":"queued","job_id":"d0b86c10-406c-4aa4-8872-0f83cb18694f"}
```

`queued` тут є підтвердженням приймання; worker уже міг почати виконання. Повтор тієї самої команди зберігає job ID. Остаточний `completed` або `failed` replay повертає `200` зі знімком. Доведена власна попередня sync-публікація може створити стабільний completed job без повторної обробки; для аудіо потрібні незмінні початкові метадані й власний ingest. Це не пошук довільного аудіо за ім'ям чи прийняття чужого receipt.

| Умова | HTTP-поведінка |
| --- | --- |
| File complete без body, `{}` або `{"async_finalization":false}` | Попередній `200` файловий receipt |
| Audio receive без поля або з `false` | Попередній `201 {"audio": ...}`; дублікат назви — `409 device_audio_name_conflict` |
| Лише literal `true` | Async opt-in; query parameter не вмикає його |
| `null`, рядок/число, невідомі ключі, зламаний JSON | `400`; відсутній audio body також `400` |
| File JSON понад 1024 байти | `413`; непорожній body без `application/json` — `415` |
| Непідтримана версія TUS для file complete | Попередній `412` і TUS headers |
| Неповний/невалідний upload | Помилка чинного endpoint до приймання; job не вважається прийнятим |
| Інша незмінна audio-команда для прийнятого source | `409 command_conflict`; другого job немає |
| Чужий прийнятий source/job | Непрозорий `404` |
| Вимкнене нове приймання, вичерпана квота, зайняте джерело чи невизначений admission COMMIT | `503` із `Retry-After`, без вигаданого job ID |
| Sync звернення до джерела активного async job | Тимчасова недоступність `503` із `Retry-After`, без `202` |

До приймання помилка має envelope свого endpoint: file domain error — `{"code":"..."}`, audio/app error може бути JSON із `message`/`details` або plain text. Зокрема вимкнене нове audio-приймання повертає `503` із текстовим body без `Content-Type`; не намагайтеся безумовно декодувати його як JSON. Це не `FinalizationError` job. Точний код/порядок валідації залишається частиною відповідного endpoint. Якщо відповідь загубилась або COMMIT невизначений, повторіть **ту саму** команду після паузи: `503` чи мережевий обрив не доводять відсутність job. Не створюйте новий upload, щоб обійти невизначеність.

## Статус і дії клієнта

```bash
curl --fail-with-body -b "$COOKIE_JAR" -i \
  "$API_BASE/api/device/upload-finalization-jobs/$JOB_ID"
```

GET не запускає роботу, повтор чи звірку. Доступ має лише початковий обліковий запис з актуальною read-видимістю Device; нова сесія того самого облікового запису дозволена. Втрата write-права сама по собі не ховає статус. Перед публікацією виконавець перевіряє актуальні права; виявлене відкликання забороняє публікацію. Одночасна зміна прав успадковує чинну межу authorization snapshot: `wd` і `wd_files` є окремими БД, тому відкликання прав не є атомарним із commit публікації. Без автентифікації — `401`, некоректний canonical lowercase hyphenated job UUID — `400`, відсутній/чужий/невидимий job — `404`, недоступна DB або перевірка прав — `503`. Відповіді статусу та розпізнаного async opt-in мають `Cache-Control: private, no-store`.

GET повертає `200` для будь-якого доступного стану, включно з `failed` і `outcome_unknown`. Усі поля знімка присутні; приклад completed file:

```json
{
  "job_id": "d0b86c10-406c-4aa4-8872-0f83cb18694f",
  "kind": "file",
  "status": "completed",
  "created_at": "2026-10-27T10:00:00+00:00",
  "updated_at": "2026-10-27T10:00:02+00:00",
  "finished_at": "2026-10-27T10:00:02+00:00",
  "retry_after_seconds": null,
  "result": {
    "upload_id": "55202edc-3e86-4a34-b997-3f56859f8e62",
    "file_id": "07c8ec42-3252-4bb6-b69a-91c357293eef",
    "revision": 1,
    "status": "completed"
  },
  "error": null
}
```

`kind` — `file`/`audio`; для completed audio `result` має попередню форму `{"audio": ...}` з полями `id`, `device_id`, `name`, `recording_started_at`, `recording_ended_at`, `duration_seconds`, `processed`, `processing_version`. Результат фіксується під час завершення/прийняття попередньої публікації: це історичний receipt, а не актуальна ревізія файлу, пізніші правки аудіо чи стан ASR. Транскрипція і підготовка похідних матеріалів продовжують окремий чинний lifecycle.

| `status` | Значення та дія |
| --- | --- |
| `queued` | Джерело захищене; чекати |
| `processing` | Виконавець працює; чекати |
| `retry_wait` | Безпечний повтор після тимчасової відмови; `error.action = retry_poll` |
| `outcome_unknown` | Запис/публікація ще потребує доказів; автоматична звірка, `retry_poll` |
| `completed` | Підтверджений результат у `result`, `error = null` |
| `failed` | Остаточна відмова, `result = null`; виконати `error.action` |

У неостаточних станах `finished_at`/`result` — `null`, `retry_after_seconds` — 1–300; GET також має `Retry-After`. Дотримуйтесь цієї затримки. Для completed/failed `finished_at` містить RFC3339 timestamp, `retry_after_seconds = null`. `error` — `null` для queued/звичайного processing або об'єкт `{code,message,action}` для діагностики; часові мітки мають явний часовий пояс.

| Код job | Дія |
| --- | --- |
| `dependency_unavailable`, `execution_capacity_unavailable` | `retry_poll`: джерело збережене, не передавати байти знову |
| `storage_outcome_unknown` | `retry_poll`: дочекатися звірки; цей код також покриває невизначеність публікації |
| `source_digest_mismatch`, `invalid_audio`, `unsupported_audio` | `new_upload`: нове коректне джерело |
| `device_audio_name_conflict`, `target_revision_changed`, `command_conflict` | `correct_request`: виправити ціль/метадані в новій операції |
| `publication_forbidden`, `target_unavailable` | `contact_operator`: перевірити права/ціль |

Не переводьте `retry_wait`/`outcome_unknown` у локальну остаточну помилку за таймером. Загального ліміту віку чи кількості безпечних повторів немає; backoff із jitter обмежує паузу, а phase timeout обмежує спробу, не життя job. Недоступні докази не є доведеною втратою джерела. `outcome_unknown` може тривати невизначено довго, утримуючи джерело, квоти й write credits; це свідома межа доступності заради безпечної публікації. Нових cancel/retry endpoints немає, повтор команди не скидає `failed`.

Історія job у цій версії не видаляється, гарантуючи щонайменше 30 днів і стабільний terminal replay після cleanup джерела. DELETE/PATCH захищеного прийнятого джерела не дозволяє його знищити; звичайний DELETE неприйнятого upload зберігається. Ця сторінка описує публічний HTTP-контракт; відповідні [типи запитів, знімків і діагностики](../wdintel-rs/src/devices/upload_finalization/types.rs) визначені в backend.

## Спостереження та відновлення

Якщо експорт метрик до SigNoz увімкнено на вкладці «Моніторинг» системних налаштувань, метрики експортуються через вказану там адресу (OTLP). Назви інструментів мають префікс `echo.device_upload.finalization.`:

| Суфікс | Атрибути / зміст |
| --- | --- |
| `jobs`, `oldest.age` | `kind,state`: кількість job та вік найстарішого від `created_at`, секунди |
| `retained_bytes` | `kind`: зарезервовані байти джерел, не використання всього диска |
| `write_credits`, `write_credits.saturated` | `kind`: утримувані невизначені записи та 0/1 досягнення configured limit |
| `events.count` | `kind,event,outcome`: приймання, спроби й результати |
| `duration` | `kind,phase,outcome`: тривалість, секунди; admission відокремлено від виконання |
| `exporter.active` | 0/1: активний elected DB exporter |

DB gauges збираються раз на 30 с одним elected exporter, щоб API/worker не множили глобальну чергу. При втраті DB/election його gauges скидаються та active стає 0; перевіряйте свіжість і active перед висновком «черга порожня». Для drain дивіться саме неостаточні стани, бо terminal history зберігається, а `oldest.age` для completed природно росте. Event/duration серії належать процесам; логи/метрики не замінюють job snapshot і receipt.

Кількість і найстаріший `created_at` для `completed`/`failed` підтримуються транзакційним DB trigger у чотирьох можливих агрегатах; регулярний збір читає їх і частковий індекс активних станів. Його вартість не залежить від terminal history. Міграція `m20261028_153759_finalization_terminal_metrics` один раз перераховує наявну історію та будує індекс, блокуючи записи в таблицю job до завершення міграції.

Якщо прогрес зупинився, збережіть job ID, час, код/стан, sanitized логи, доступність `wd`/`wd_files`/S3/Redis, вільне місце та стан source/slot root. Не публікуйте cookies, конфігурацію з ключами, приватні шляхи чи object keys. Після повернення залежностей worker сам звіряє наслідки попереднього запису, потім завершує або безпечно повторює початковий job без клієнтського GET.

Якщо root став недоступним, поверніть той самий mount, права та початкові джерела/pin-маркери; не створюйте порожній root поверх очікуваного mount. Зберігайте узгоджені DB/storage backups, ключ і bucket. Audio pin перевіряє також inode/device файлу й каталогу: копіювання байтів на новий диск не гарантує recovery. Автоматичного імпорту заміненого джерела або ремонту pin немає; таке відновлення потребує окремої перевіреної процедури оператора.

Фізична втрата диска без копії не відновлює байти. `source_lost`/`new_upload` визначений у типах діагностики, але поточні адаптери не мають автоматичного класифікатора доведеної фізичної втрати: відсутнє/недоступне джерело може залишатися `retry_wait` або `outcome_unknown`. Не очікуйте автоматичного terminal `source_lost` за віком; перевірте джерело й докази публікації з оператором. Підтриманого ручного переходу в `source_lost` немає. Не знімайте pin, lease, credit чи quota вручну і не видаляйте candidate objects, щоб «розблокувати» job: запізніла операція сховища ще може завершитися.

## Вимкнення, drain і rollback

1. Перед першим увімкненням оновіть схему `wd_files` і всі API, workers та cleaners до версії, що розуміє pins/ownership/attempt keys. Старі canonical writers сумісні з розширеною схемою; це не дозвіл запускати старий cleaner над живими pins. Збережіть DB/storage backup та ключ. Увімкніть opt-in лише після перевірки спільного root і робочого `bgworker`.
2. Для зупинки нових приймань встановіть `enabled = false` в усіх API та worker і перезапустіть їх штатно, залишивши recovery-capable `bgworker` працювати. Sync залишається доступним, окрім джерел активних async job; replay/status не вимикаються. Старі незавершені TUS uploads не потрапляють у чергу автоматично.
3. Дочекайтеся відсутності queued/processing/retry_wait/outcome_unknown і завершення cleanup/accounting. У `wd_files` read-only запит нижче повинен повернути нулі. Невизначеність залежностей може не дати drain завершитися; відновіть докази, а не примусово закривайте job.

   ```sql
   SELECT count(*) FILTER (WHERE status IN ('queued','processing','retry_wait','outcome_unknown')) AS active_jobs,
          count(*) FILTER (WHERE source_release_state <> 'released' OR quota_released_at IS NULL) AS retained_sources
   FROM device_upload_finalization_job;
   SELECT count(*) AS held_write_credits
   FROM device_upload_finalization_attempt WHERE write_credit_held;
   SELECT scope, reserved_jobs, reserved_source_bytes, unresolved_writes
   FROM device_upload_finalization_budget
   WHERE reserved_jobs <> 0 OR reserved_source_bytes <> 0 OR unresolved_writes <> 0;
   SELECT count(*) AS pending_attempt_cleanup
   FROM device_upload_finalization_attempt WHERE phase = 'retired' AND cleanup_confirmed_at IS NULL;
   ```

4. Для штатної зупинки дайте процесу завершити cancellation/join дочірніх операцій; supervisor stop timeout має бути щонайменше 135 с при default grace 120 с. Slot/source guards не звільняються раніше завершення операції. Непереривний kernel/filesystem syscall може перевищити grace: жорстка 120-секундна гарантія для завислого диска відсутня. Після crash залишайте джерела/схему/ключ незмінними для автоматичного recovery.
5. Найбезпечніший rollback функції — вимкнене нове приймання при збереженій новій схемі та recovery-capable версії. Drain не робить старий binary автоматично сумісним із опублікованими attempt-specific keys. Повернення до старого binary/schema потребує окремо перевіреної процедури міграції/відновлення; автоматичного перезапису цих об'єктів у canonical keys немає.

**Не обходьте відмову schema downgrade.** Міграція `m20261027_112601_synchronous_finalization_adoption` відмовляє при будь-якій збереженій історії job; `m20261027_093747_file_finalization_ownership` — при file ownership evidence; базова `m20261014_182354_device_upload_finalization` — при job/attempt evidence, ненульових budgets або noncanonical publication. Навіть повністю drained job зберігає історію. Видалення evidence, тригерів чи записів `seaql_migrations` заради `down` руйнує idempotency та прив'язку опублікованого вмісту і не є підтриманим rollback.

## Локальна перевірка rollout

[Owned harness](../scripts/devices/upload_finalization_harness.py) створює приватний root, пару disposable DB, Moto S3, два debug API та `bgworker`. Потрібні зібраний `target/debug/wdintel-rs`, Python 3.11+, PostgreSQL/PostGIS, Redis, PostgreSQL CLI, ffmpeg/ffprobe та lsof. Вхідний приватний TOML має явно вказувати ізольовані loopback PostgreSQL/Redis на нестандартних портах; storage Python — venv із [test-storage requirements](../deploy/ci/test-storage-requirements.txt). Harness відмовляється використовувати стандартні порти 5432/6379.

```bash
export ECHO_CONFIG_PATH=/absolute/private/isolated-config.toml
export UPLOAD_FINALIZATION_STORAGE_PYTHON=/absolute/moto-venv/bin/python
auf_root="$(python3 scripts/devices/upload_finalization_harness.py prepare)"
python3 scripts/devices/upload_finalization_harness.py start --root "$auf_root"
python3 scripts/devices/upload_finalization_harness.py scenario --root "$auf_root" --name rollout
python3 scripts/devices/upload_finalization_harness.py stop --root "$auf_root"
```

Після помилки також виконайте `stop --root` із точним root цього запуску; не редагуйте private manifest. Harness перевіряє ownership перед видаленням ресурсів і зберігає приватні логи/receipts. `rollout` перевіряє admission-off recovery, sync, SIGTERM/SIGKILL worker, canonical SQL writer і відмови downgrade на поточному binary та локальній файловій системі. Це не виконання старого binary/cleaner або перевірка production.

Перед увімкненням у конкретному середовищі окремо перевірте версії всіх API/workers/cleaners, спільний стійкий mount і права процесів, збереження ключа/bucket, supervisor stop timeout, backups та доступність job після штатного restart із вимкненим новим прийманням. Підтвердьте drain через DB/receipts і свіжі метрики; локальний harness не доводить fleet rollout, production latency або придатність мережевого mount. Нову топологію потрібно перевіряти окремо до її використання.
