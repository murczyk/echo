import { useCallback } from 'react';

import type { KpiDuration, KpiPeriod } from '../../../../Bindings';
import {
  getKpiActivity,
  getKpiNotifications,
  getKpiReports,
  getKpiRequests,
} from '../../services/api/kpi';
import { CountChart } from './CountChart';
import { KpiPanel, MetricCard, SnapshotState } from './KpiSummary';
import { useSnapshot } from './use-kpi-data';

export function PeriodLabel({ period }: { period: KpiPeriod }) {
  return (
    <p>
      Період UTC: {new Date(period.since).toISOString()} — {new Date(period.until).toISOString()}.
      Початок включено, кінець не включено.
    </p>
  );
}

function DurationCards({ duration, title }: { duration: KpiDuration; title: string }) {
  return (
    <>
      <p>
        {title}: {duration.samples} коректних вимірів; виключено {duration.excluded} записів без
        коректної тривалості.
      </p>
      <div className="grid gap-echo-md echo-md:grid-cols-2">
        <MetricCard
          title={`${title}: медіана`}
          value={duration.medianSeconds?.toFixed(1) ?? null}
          description="Секунди. Без вимірів значення недоступне."
        />
        <MetricCard
          title={`${title}: p90`}
          value={duration.p90Seconds?.toFixed(1) ?? null}
          description="Секунди. 90-й перцентиль коректних вимірів."
        />
      </div>
    </>
  );
}

export function ReportsHistory({ period }: { period: KpiPeriod }) {
  const load = useCallback(() => getKpiReports(period), [period]);
  const snapshot = useSnapshot(load, 'Не вдалося завантажити історію звітів KPI');
  return (
    <KpiPanel title="Генерація звітів за період">
      <SnapshotState
        snapshot={snapshot}
        label="історія звітів"
        retry={() => void snapshot.reload()}
      />
      {snapshot.data && (
        <>
          <PeriodLabel period={snapshot.data.period} />
          <p>
            Системні показники з report_history за часом створення запиту. Кожен запис рахується
            один раз, включно з повторними спробами в ньому. Окремий повторний запуск є новим
            записом. Це поточний стан збереженої історії report_history. Окремий legacy-журнал не
            додається; його повноту та перенесення не підтверджено.
          </p>
          <div className="grid gap-echo-md echo-md:grid-cols-3">
            <MetricCard
              title="Запити генерації"
              value={snapshot.data.total}
              description="Усі статуси у вибраному періоді."
            />
            <MetricCard
              title="Успішні генерації"
              value={snapshot.data.done}
              description="Записи зі статусом done; не завантаження файлів."
            />
            <MetricCard
              title="Невдалі генерації"
              value={snapshot.data.failed}
              description="Поточний статус failed, включно зі скасованими запитами."
            />
          </div>
          <DurationCards duration={snapshot.data.generation} title="Тривалість генерації" />
          <p>
            Від started_at до completed_at успішного запиту з фоновим завданням, включно зі
            збереженням результату; не час у черзі та не тривалість кожної окремої спроби.
            Синхронні, архівні та legacy-записи без підтвердженого часу генерації виключено з
            тривалостей, але включено до кількості звітів.
          </p>
          <div className="grid items-start gap-echo-lg xl:grid-cols-3">
            <CountChart title="Успішні звіти за типами" rows={snapshot.data.byKind} />
            <CountChart title="Успішні звіти за авторами" rows={snapshot.data.byAuthor} />
            <CountChart title="Успішні звіти за днями UTC" rows={snapshot.data.byDay} />
          </div>
        </>
      )}
    </KpiPanel>
  );
}

export function ActivityHistory({ period }: { period: KpiPeriod }) {
  const load = useCallback(() => getKpiActivity(period), [period]);
  const snapshot = useSnapshot(load, 'Не вдалося завантажити спостереження активності');
  return (
    <KpiPanel title="Спостереження сторінок">
      <SnapshotState
        snapshot={snapshot}
        label="спостереження активності"
        retry={() => void snapshot.reload()}
      />
      <p>
        Greptime, лише поточний public_host. Унікальні ID облікових записів, включно з технічними,
        без об’єднання з ботами. Події включають keep-alive і автоматичні запити; ці показники не
        підтверджують дії людини та не є DAU/WAU/MAU.
      </p>
      {snapshot.data && (
        <>
          <PeriodLabel period={snapshot.data.period} />
          <p>
            Груп із невідомою ідентичністю (виключено): {snapshot.data.unmappedAccountGroups}. Черга
            цього процесу від запуску: прийнято {snapshot.data.queueEnqueued}, відкинуто через
            переповнення {snapshot.data.queueDropped}. Це не повний облік втрат; збої запису та інші
            процеси не враховано.
          </p>
          {!snapshot.data.available ? (
            <p role="status">Недоступно: {snapshot.data.reason}</p>
          ) : (
            <>
              <p>
                Перше / останнє спостереження UTC: {snapshot.data.observedFrom} /{' '}
                {snapshot.data.observedUntil}. Безперервність і повнота історії не гарантовані;
                відсутні дні не заповнюються нулями.
              </p>
              <MetricCard
                title="Облікові записи зі спостереженнями"
                value={snapshot.data.accounts}
                description="Унікальні ID за період, включно з історичними та технічними обліковими записами. Фільтри бази не застосовуються."
              />
              <div className="grid items-start gap-echo-lg xl:grid-cols-2">
                <CountChart
                  title="Спостережені облікові записи за днями UTC"
                  rows={snapshot.data.byDay}
                />
                <CountChart
                  title="Спостережені облікові записи за сторінками"
                  rows={snapshot.data.byPage}
                  description="Один обліковий запис може бути на кількох сторінках. Це не лічильник кліків чи сесій."
                />
              </div>
            </>
          )}
        </>
      )}
    </KpiPanel>
  );
}

function RequestHistory({ period }: { period: KpiPeriod }) {
  const load = useCallback((signal: AbortSignal) => getKpiRequests(period, signal), [period]);
  const snapshot = useSnapshot(load, 'Не вдалося завантажити якість API');
  const data = snapshot.data;
  const percentage = data?.total
    ? ((100 * ((data.serverErrors ?? 0) + (data.clientErrors ?? 0))) / data.total).toFixed(2) + '%'
    : null;
  return (
    <KpiPanel title="Якість запитів API">
      <SnapshotState snapshot={snapshot} label="якість API" retry={() => void snapshot.reload()} />
      <p>
        Greptime: записані відповіді та помилки middleware для /api/ поточного public_host;
        початкові події запиту не рахуються. Черга та зберігання можуть втрачати події. Це не
        доступність системи, не час завантаження сторінки та не успішність входу.
      </p>
      {data && (
        <>
          <PeriodLabel period={data.period} />
          {!data.available ? (
            <p role="status">Недоступно: {data.reason}</p>
          ) : (
            <>
              <div className="grid gap-echo-md echo-md:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                  title="Записані відповіді API"
                  value={data.total}
                  description="HTTP 100–599. Неповне покриття історії."
                />
                <MetricCard
                  title="Помилки клієнта API"
                  value={data.clientErrors}
                  description="HTTP 400–499."
                />
                <MetricCard
                  title="Помилки сервера API"
                  value={data.serverErrors}
                  description="HTTP 500–599, включно з помилками middleware."
                />
                <MetricCard
                  title="Частка відповідей з помилкою"
                  value={percentage}
                  description="(4xx + 5xx) / усі записані відповіді API × 100%."
                />
              </div>
              <CountChart title="Відповіді API за HTTP-статусом" rows={data.byStatus} />
            </>
          )}
        </>
      )}
    </KpiPanel>
  );
}

function NotificationHistory({ period }: { period: KpiPeriod }) {
  const load = useCallback(() => getKpiNotifications(period), [period]);
  const snapshot = useSnapshot(load, 'Не вдалося завантажити доставку сповіщень');
  return (
    <KpiPanel title="Сповіщення в месенджері">
      <SnapshotState snapshot={snapshot} label="сповіщення" retry={() => void snapshot.reload()} />
      {snapshot.data && (
        <>
          <PeriodLabel period={snapshot.data.period} />
          <MetricCard
            title="Сповіщення для відправлення"
            value={snapshot.data.total}
            description="Збережені записи messenger_alert_delivery за часом створення; не всі сповіщення системи."
          />
          <CountChart title="Стани відправлення сповіщень" rows={snapshot.data.byStatus} />
          <DurationCards
            duration={snapshot.data.transport}
            title="Час до відправлення в транспорт"
          />
          <p>
            sent і sent_at підтверджують записаний етап транспорту, а не доставку на пристрій чи
            прочитання. Тривалість від створення запису до sent_at включає очікування та повторні
            спроби.
          </p>
        </>
      )}
    </KpiPanel>
  );
}

export function QualityHistory({ period }: { period: KpiPeriod }) {
  return (
    <>
      <RequestHistory period={period} />
      <NotificationHistory period={period} />
    </>
  );
}
