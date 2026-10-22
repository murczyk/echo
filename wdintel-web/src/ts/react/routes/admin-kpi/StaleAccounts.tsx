import { useState } from 'react';

import type { Login } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { accountStatus, formatSnapshotTime, statusLabels } from './helpers';

const KPI_REVIEW_PAGE_SIZE = 20;

export function StaleAccounts({ accounts }: { accounts: Login[] }) {
  const [visibleCount, setVisibleCount] = useState(KPI_REVIEW_PAGE_SIZE);
  const oldestFirst = [...accounts].sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
  return (
    <section aria-label="Облікові записи для перевірки" className="space-y-echo-md">
      <h2 className="m-0 text-echo-lg font-semibold">Понад 90 днів: список для перевірки</h2>
      <p>
        Давній запис активності — привід перевірити обліковий запис. Видалення зі сторінки KPI
        недоступне.
      </p>
      {accounts.length === 0 ? (
        <p>Облікових записів для перевірки немає.</p>
      ) : (
        <>
          <div className="max-w-full overflow-x-auto">
            <table className="w-full text-echo-sm">
              <caption className="sr-only">
                Облікові записи із записом активності понад 90 днів тому
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="p-echo-sm text-left">
                    Логін
                  </th>
                  <th scope="col" className="p-echo-sm text-left">
                    Організм
                  </th>
                  <th scope="col" className="p-echo-sm text-left">
                    Статус
                  </th>
                  <th scope="col" className="p-echo-sm text-left">
                    Останній запис активності
                  </th>
                </tr>
              </thead>
              <tbody>
                {oldestFirst.slice(0, visibleCount).map((login) => (
                  <tr key={login.id} className="border-t border-echo-border">
                    <th scope="row" className="break-all p-echo-sm text-left font-normal">
                      <a href={`/admin/users-neo/${encodeURIComponent(login.id)}`}>{login.login}</a>
                    </th>
                    <td className="p-echo-sm">{login.organismName ?? 'Не вказано'}</td>
                    <td className="p-echo-sm">{statusLabels[accountStatus(login)]}</td>
                    <td className="p-echo-sm">{formatSnapshotTime(login.lastActiveAt!)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {visibleCount < accounts.length && (
            <PowerButton onClick={() => setVisibleCount((count) => count + KPI_REVIEW_PAGE_SIZE)}>
              Показати ще
            </PowerButton>
          )}
        </>
      )}
    </section>
  );
}
