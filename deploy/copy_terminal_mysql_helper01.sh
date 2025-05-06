#!/bin/sh
#
# This script is intended to be put inside of the docker container by copy_terminal_mysql.sh
#
set -ex
mysqld_safe --skip-grant-tables --skip-networking &
sleep 5;
echo "UPDATE mysql.user SET authentication_string=null WHERE User='root';" | mysql -u root terminal
echo "update mysql.user set host='%' where user='root' and host = 'localhost';" | mysql -u root terminal
echo "flush privileges;" | mysql -u root terminal
echo "ALTER USER 'root'@'%' IDENTIFIED BY 'terminal'; flush privileges;" | mysql -u root terminal
