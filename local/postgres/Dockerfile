# Existing PostgreSQL 14 volumes must be reset or migrated first; see ../README.md.
FROM postgres:18.4-bookworm

RUN apt-get update && apt-get install -y postgresql-18-postgis-3-scripts

COPY init.sql /docker-entrypoint-initdb.d
