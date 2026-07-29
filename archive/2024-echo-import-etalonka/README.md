# Import Etalonka

See [the ticket](https://github.com/k-bx/echo/issues/50) for full info on launching MS SQL in Docker etc.

Running:

```
ssh jvln
cd /fast/kon/workspace/echo-dev/archive/echo-import-etalonka
git pull
cargo run --release -- --mssql-host localhost --mssql-user sa --mssql-password <TODO> --mssql-port 1401 --pg-host localhost --pg-user wd --pg-password <TODO> --pg-port 5432 --pg-db wd
```
