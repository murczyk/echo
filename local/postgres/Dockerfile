FROM postgres:14.12-bookworm

RUN apt-get update && apt-get install -y postgresql-14-postgis-3-scripts

COPY init.sql /docker-entrypoint-initdb.d
