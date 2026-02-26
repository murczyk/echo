export function messagesCountText(count: number) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return `${count} повідомлень`;
  }

  if (lastDigit >= 1 && lastDigit <= 4) {
    return `${count} повідомлення`;
  }

  return `${count} повідомлень`;
}

export function daysCountText(count: number) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 19) {
    return `${count} днів`;
  }

  if (lastDigit === 1) {
    return `${count} день`;
  }

  if (lastDigit >= 2 && lastDigit <= 4) {
    return `${count} дні`;
  }

  return `${count} днів`;
}