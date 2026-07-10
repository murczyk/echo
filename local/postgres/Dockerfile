FROM postgres:18.4-bookworm

RUN apt-get update && apt-get install -y postgresql-18-postgis-3-scripts

COPY init.sql /docker-entrypoint-initdb.d
