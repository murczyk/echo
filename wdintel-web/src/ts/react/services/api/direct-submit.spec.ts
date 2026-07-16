import { describe, expect, it } from 'vitest';

import { HttpRequestError } from './client';
import { formatDirectSubmitError } from './direct-submit';

describe('formatDirectSubmitError', () => {
  it('shows a user-friendly backend validation error', () => {
    const error = new HttpRequestError(400, 'Додайте текст повідомлення або медіафайл.');

    expect(formatDirectSubmitError(error, 'save')).toBe(error.message);
  });

  it('keeps an unknown business error detail', () => {
    const error = new HttpRequestError(400, 'Некоректна частота');

    expect(formatDirectSubmitError(error, 'save')).toBe('Некоректна частота');
  });

  it('replaces internal error text with an actionable message', () => {
    const error = new HttpRequestError(500, 'Internal server error');

    expect(formatDirectSubmitError(error, 'save')).toBe(
      'Не вдалося зберегти повідомлення. Спробуйте ще раз. Якщо помилка повторюється, зверніться до адміністратора.',
    );
  });
});
