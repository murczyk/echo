# Iggy debian wrapper

This project is a thin wrapper on top of [Apache Iggy](https://github.com/apache/iggy), it
configures `iggy-server` binary wrapped in a debian package.
check out `../justfile` for commands `builder-build-iggy` and `deploy-iggy`.

## future plans:
- move echo-iggy to a dedicated github project echoua-info/iggy-wrapper
- add dedicated builder servers for different OS and arch
- add github runner to automatically rebuild deb once new iggy version is out