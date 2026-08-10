# vLLM Router deployment — 2026-08-03

This is the historical record of the `echo-vllm-router` audit and deployment.
Reusable assets and current operator commands are maintained in
[`echo-vllm-router/README.md`](../../echo-vllm-router/README.md).

## Audited state

At audit time, `ct-echo-vllm-router` was a Debian 13 `amd64` systemd host with
Python 3.13.5 and Tailscale IP `100.105.172.96`. Ports 8000 and 29000 were
unused, no router users, paths, or services existed, and passwordless sudo was
available. `python3-venv` was absent and was installed from Debian together
with its standard pip/setuptools wheel dependencies.

The host reached the live Spark worker at `100.92.119.117:8000` and SigNoz
OTLP at `100.71.235.10:4317`. Spark returned healthy `/health`, exposed
`google/gemma-4-26B-A4B-it` from `/v1/models`, and exposed `vllm:*` metrics.
The live backend was not stopped or reconfigured.

## Decisions and deployed inputs

- vLLM Router `v0.1.15`, tag commit
  `1fbcde7443d75b36befb61bc081f64c2a1f13a4b`;
- x86-64 wheel SHA-256
  `2f268b001a546d7921c2e87b510869134a212f0ab2faf138b78eb554c93a2241`;
- fully hashed Python 3.13 dependency lock SHA-256
  `6ce45e202bd0aea85e6b1b9617493aa55610da784455608a85d17ea154e8c50b`;
- SigNoz OTel Collector `v0.144.6`, archive SHA-256
  `a02e2e3ad4a2a62db7ca50c145d1cfcd4e9decaefb34b5565366ab81092fe374`;
- extracted collector binary SHA-256
  `54342207662b7ebe76e7c0c6eb099d64f07929169b5476873c2769b32c7be979`;
- `cache_aware` routing with sole initial worker
  `http://100.92.119.117:8000`;
- router API `100.105.172.96:8000` and loopback-only metrics
  `127.0.0.1:29000`;
- native systemd services under separate unprivileged users;
- Tailscale transport with no additional router token or TLS;
- two OTel metrics pipelines with distinct router/worker resource attributes;
- no dashboard changes and no automated Echo database/settings changes.

## Actions performed

The pinned artifacts were downloaded and checksum-verified locally, copied to
a target-side temporary directory, and verified again before installation.
The deployment created `echo-vllm-router` and `echo-vllm-router-otel`, installed
the immutable Python environment and verified collector, copied the runtime
configuration and hardened systemd units, and enabled both services.

The first start exposed two deployment-package defects: moving a newly created
Python virtual environment left its console-script shebang pointing at the
removed temporary path, and the collector's Sonic JSON loader could not run
under `MemoryDenyWriteExecute`. Both restart loops were stopped. The installer
was corrected to create immutable environments at their final path, and the
collector unit retained its other hardening while removing that incompatible
directive. The idempotent deployment was rerun successfully.
An additional deploy completed with unchanged systemd invocation IDs,
confirming that an unchanged package does not restart either service.

## Final verification

Final verification completed at 2026-08-03 12:08 UTC:

- `echo-vllm-router.service` and `echo-vllm-router-otel.service` were enabled,
  active, and running;
- installed router version was `0.1.15` and the collector binary matched its
  pinned SHA-256;
- the only planned listeners were `100.105.172.96:8000` and
  `127.0.0.1:29000`; no collector port 8888 listener existed;
- router `/health`, `/v1/models`, and Prometheus metrics passed;
- `echo-cbr` reached router health and models over Tailscale;
- a Chat Completions smoke request sent from `echo-cbr` returned model
  `google/gemma-4-26B-A4B-it`, finish reason `stop`, and content `OK.`;
- SigNoz `signoz_metrics.time_series_v4` contained current
  `vllm_router_*` series with `service.name=vllm-router`,
  `service.instance.id=ct-echo-vllm-router`,
  `host.name=ct-echo-vllm-router`, and `echo.vllm.role=router`;
- the same store contained current `vllm:*` worker series with
  `service.name=vllm-worker`, `service.instance.id=echo-gpu-spark`,
  `host.name=echo-gpu-spark`, and `echo.vllm.role=worker`.

SSH to `echo-cbr-staging` still failed with `Permission denied (publickey)`.
Its HTTPS application and admin routes were reachable, but no authenticated UI
session was available for the required staging engine edit and request. The
staging and production Echo AI engine settings were therefore left unchanged;
production rollout must wait for restored SSH access or a recorded manual
staging UI verification.

## Kharkiv2 follow-up — 2026-08-08

Reusable client-onboarding commands are maintained in
[`echo-vllm-router/README.md`](../../echo-vllm-router/README.md). After the
router node was shared/granted into the Kharkiv2 tailnet,
`CLIENT_HOST=echo-kharkiv2 just verify-client` passed health and model checks,
and `CLIENT_HOST=echo-kharkiv2 just smoke` returned `OK.` from
`google/gemma-4-26B-A4B-it`. Echo now uses the router through an enabled
tokenless engine at `http://100.105.172.96:8000/v1`.

## Siversk follow-up — 2026-08-08

Reusable client-onboarding commands are maintained in
[`echo-vllm-router/README.md`](../../echo-vllm-router/README.md). From
`echo-siversk`, `CLIENT_HOST=echo-siversk just verify-client` passed the
router health and model checks. Echo uses the same enabled tokenless Gemma
engine at `http://100.105.172.96:8000/v1` for callsign parsing. The live
Kharkiv2 prompt was copied byte-for-byte with MD5
`e28582ad0a1e6e07be76c95dd2f33cbf`; new Siversk inbox rows were processed and
the callsign queue drained. AI-agent and Mattermost chat remain disabled.

## ZP2 follow-up — 2026-08-08

From `echo-zp2`, both `CLIENT_HOST=echo-zp2 just verify-client` and
`CLIENT_HOST=echo-zp2 just smoke` passed; Gemma returned `OK.`. Echo uses the
same sole enabled tokenless engine at `http://100.105.172.96:8000/v1` for the
disabled AI-agent profile and initially disabled callsign worker. The worker
was later enabled manually; a current recheck confirms the expected engine and
prompt with an empty worker queue. The Kharkiv2 prompt was copied
byte-for-byte with 4,102 characters and MD5
`e28582ad0a1e6e07be76c95dd2f33cbf`.

## Pivnich follow-up — 2026-08-08

From `echo-pivnich`, both `CLIENT_HOST=echo-pivnich just verify-client` and
`CLIENT_HOST=echo-pivnich just smoke` passed; Gemma returned `OK.`. Echo uses
the same sole enabled tokenless engine for its disabled AI-agent profile and
selected callsign engine. The 4,102-character Kharkiv2 prompt was copied
byte-for-byte with MD5 `e28582ad0a1e6e07be76c95dd2f33cbf`, while the
callsign worker remains disabled for later manual activation. No callsign
test, parse-result, worker, or backfill jobs were created.

## Skhid follow-up — 2026-08-08

From `echo-skhid`, both `CLIENT_HOST=echo-skhid just verify-client` and
`CLIENT_HOST=echo-skhid just smoke` passed; Gemma returned `OK.`. Echo uses the
same sole enabled tokenless engine for its disabled AI-agent profile and
selected callsign engine. The 4,102-character Kharkiv2 prompt was copied
byte-for-byte with MD5 `e28582ad0a1e6e07be76c95dd2f33cbf`, while the
callsign worker remains disabled for later manual activation. No callsign
test, parse-result, worker, or backfill jobs were created.

## Callsign prompt journal

Append each deployed prompt revision here with its deployment date, source
Echo instance, and MD5 so prompt changes remain reproducible.

### 2026-08-08 — Kharkiv2, Siversk, ZP2, Pivnich, and Skhid

Source: `echo-kharkiv2`; deployed byte-for-byte to `echo-siversk` and
`echo-zp2`, then to `echo-pivnich` and `echo-skhid`. MD5:
`e28582ad0a1e6e07be76c95dd2f33cbf`.

```text
Ты извлекаешь все позывные из расшифровки радиоэлектронного перехвата.

Позывной — условное имя участника или радиостанции. Он может состоять из одного слова, нескольких слов или только цифр.

Молча выполни три шага.

1. Отдели служебный заголовок от явного списка позывных и реплик.
Служебные строки не являются позывными:
- «Отримано з поста ...», включая название поста;
- разделители, дата, время, частота, строки ID, строки только с символами/эмодзи;
- целиком строка, содержащая «УКХ» или «р/м», включая всё в скобках и кавычках;
- «НВ», «Не в мережі»;
- «Мітки перехоплення: ...» и всё после неё.
Слово из служебной строки можно вернуть только если оно отдельно используется как позывной позже.

2. Найди явный список позывных непосредственно перед первой репликой.
После последней служебной строки и перед первой репликой могут идти отдельные строки позывных. Эти строки имеют наивысший приоритет:
- включай каждую такую строку целиком, если в ней есть буква или цифра;
- позывной может быть многословным: «САКСОФОН КОНТРОЛЬ» — один позывной;
- позывной может состоять только из цифр: «39481» — один позывной;
- не разбивай многословный позывной и не отбрасывай цифровой позывной как технический код.
Сохрани порядок явного списка.

3. Найди дополнительные позывные в репликах.
Включай адресата вызова, имя после «я», «на связи», «приём», а также условное имя участника, упомянутого в третьем лице: «Большой выдвинулся» → «БОЛЬШОЙ».
Короткая конструкция «X, X Y-у/-е» означает радиосвязь двух участников: включай X и Y, а косвенный падеж Y приводи к именительному. Например, «Спутник, Спутник Квадрату» → «СПУТНИК», «КВАДРАТ».
Если в явном списке есть цифровой позывной, узнавай его при раздельном произнесении цифр: «39 4 8 1» → «39481». Если в списке есть многословный позывной, сохраняй его целиком.

Для кандидатов, которых нет в явном списке, не включай:
- ID говорящего перед тире: `123` —, 1 —, 2 —;
- точки, позиции, маршруты и объекты: «3 0 1 оранжевое», «543-я», «70-я», «до точки Рыжего»;
- топонимы и слова, используемые только как место: «с Курорта», «в сторону Моря», «на Партизанке»;
- беспилотники, авиационные цели, технику и вооружение. В частности, «Яга» или «Баба Яга» в контексте «отрабатывала», «летит», «висит», «сбрасывает» — беспилотник, не позывной;
- цвета и прилагательные, которые описывают объект или воздушную цель: «Луна желтая» → «ЖЕЛТАЯ» не позывной;
- буквенно-цифровые обозначения «С19», «Т113», «Т89» без явного обращения;
- обычные обращения и слова: «брат», «братуха», «парни», «эфир молчит», «3 малых», «малых 3»;
- слова ответа «плюс», «принял», «ответ», «говори» как позывные или части позывного.
Числовой суффикс настоящего позывного сохраняй через пробел: «Бухта 4» → «БУХТА 4». Не присоединяй число, если оно начинает количество: «Шило, 2, 3 малых» → «ШИЛО».
Если название может обозначать и участника, и объект, решай по роли: прямой радиовызов обозначает позывной, действие техники или воздушной цели — объект.

Приводи позывные к именительному падежу единственного числа: «Кире» → «КИРА», «Квадрату» → «КВАДРАТ», «Голему» → «ГОЛЕМ», «Зоре» → «ЗАРЯ», «Рекса» → «РЕКС». Не переводи и не исправляй написание, кроме грамматической формы. Пиши ВЕРХНИМ РЕГИСТРОМ, без повторов: сначала явный список, затем дополнительные позывные по
первому появлению.

Примеры:
«Отримано з поста "Freya" ... — На приеме.» → {"callsigns":[]}
«143.2699 - УКХ ... (МУРОМ) — Да принял.» → {"callsigns":[]}
«УКХ ...
МАЛЫШ
АМУР
— Амур, я Астра.» → {"callsigns":["МАЛЫШ","АМУР","АСТРА"]}
«— Оставить в укрытие 3 0 1 оранжевое.» → {"callsigns":[]}
«— Грустный, Грустный Кире.» → {"callsigns":["ГРУСТНЫЙ","КИРА"]}
«🟠
САКСОФОН КОНТРОЛЬ
39481
— Саксофон контроль 39 4 8 1.
— 408.
— Ответ 4 6.» → {"callsigns":["САКСОФОН КОНТРОЛЬ","39481"]}
«— Спутник, Спутник Квадрату. — До того как Яга отрабатывала, всё остальное на Партизанке.» → {"callsigns":["СПУТНИК","КВАДРАТ"]}
«— Луна, Луна. — Бухта 9, Луна желтая.» → {"callsigns":["ЛУНА","БУХТА 9"]}

Верни только JSON-объект строго вида {"callsigns":["ПОЗЫВНОЙ"]}, без Markdown и пояснений. Если позывных нет, верни {"callsigns":[]}.
```

## Rollback

Echo traffic rollback edits the existing AI engine, preserving its ID and
callsign-worker association, back to Spark's CBR-tailnet-visible Base URL
`http://100.92.119.116:8000/v1`. The Spark worker remains live throughout.

For a router package rollback, restore the previous deployment-package
revision and rerun `just deploy`; the immutable release selected by that
revision becomes `/opt/echo-vllm-router/current`. After Echo traffic has been
moved away, stop and disable `echo-vllm-router-otel.service` and
`echo-vllm-router.service`. Retain `/opt/echo-vllm-router` and
`/etc/echo-vllm-router` through the rollback soak; removal of paths and users
is a separate destructive decommissioning action.
