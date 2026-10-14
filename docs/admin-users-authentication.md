# User administration

An account requires a local login and can use password authentication, Delta,
or both. Local and Delta logins are independent. An active account must always
have at least one configured sign-in method.

Password characters are preserved exactly, including leading and trailing
spaces; an explicitly supplied password consisting only of whitespace is
rejected. Creating an account with password authentication disabled does not
store a supplied password. Disabling password authentication for an existing
account preserves its stored password. Unrelated fields on legacy accounts
with incomplete authentication configuration can still be edited, but
activation or changes to sign-in methods revalidate sign-in requirements.

Account deactivation is reversible: it blocks access and records the reason
(administrator action or inactivity). Reactivation clears the reason and
updates the activity timestamp. A disabled organism also blocks access,
regardless of the account's own state.
