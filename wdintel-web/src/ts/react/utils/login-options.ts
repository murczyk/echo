export type LoginOption = {
  id: string;
  login: string;
};

export function buildLoginOptions<T extends LoginOption>(logins: T[]): T[] {
  return Array.from(new Map(logins.map((login) => [login.id, login])).values()).sort((a, b) =>
    a.login.localeCompare(b.login, 'uk'),
  );
}

export function selectLoginOptions(loginIds: string[], options: LoginOption[]): LoginOption[] {
  const loginById = new Map(options.map((login) => [login.id, login]));
  return loginIds.map((id) => loginById.get(id) ?? { id, login: id });
}

export function selectedLoginIds(options: LoginOption[]): string[] {
  return options.map((login) => login.id);
}

export function formatLoginIds(
  loginIds: string[],
  loginById: ReadonlyMap<string, LoginOption>,
): string {
  return loginIds.map((id) => loginById.get(id)?.login ?? id).join(', ');
}
