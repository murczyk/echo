# Iggy debian wrapper

This project is a thin wrapper on top of [Apache Iggy](https://github.com/apache/iggy), it configures `iggy-server` binary wrapped in a debian package.

## Setup

```
just setup-iggy
```

## Other commands

Check out `../justfile` for commands:

- `switch-version-iggy` is if you want to start building different version of Apache Iggy (for example, after updating rust client to a different version)
- `deploy-config-iggy`
- `builder-build-iggy`

## future plans:
- move echo-iggy to a dedicated github project echoua-info/iggy-wrapper
- add dedicated builder servers for different OS and arch
- add github runner to automatically rebuild deb once new iggy version is out
