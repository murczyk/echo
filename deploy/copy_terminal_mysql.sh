#!/bin/sh
# Description:
#
# - copies terminal mysql to this machine and launches mysql in docker
# - rsyncs terminal attachments into /home/zptzr/storage/attachments
#
# Run as root from /root folder
set -ex
SRC_ROOT=/home/zptzr/workspace/wildducks-intel
cd /root
MYSQL_VERSION=8.0.33

RWORKDIR="/tmp"
HOST=terminal
FILE=/media/fatty/exists
if ! ssh $HOST "test -e $FILE"; then
	RWORKDIR=/tmp
    echo "File $FILE does not exist."
else
	RWORKDIR=/media/fatty
    echo "File $FILE exists."
fi
echo "> RWORKDIR is $RWORKDIR"

rsync --info=progress2 -a terminal:/var/www/terminal/attachments /home/zptzr/storage/terminal-attachments

ssh terminal 'rm -f terminal-mysql.tar.gz'
echo "terminal" | ssh terminal "sudo -S -k rm -rf $RWORKDIR/mysql"
echo "terminal" | ssh terminal "sudo -S -k cp -r /var/lib/mysql $RWORKDIR/mysql"
echo "terminal" | ssh terminal "sudo -S -k tar -czf $RWORKDIR/terminal-mysql.tar.gz $RWORKDIR/mysql"
echo "terminal" | ssh terminal "sudo -S -k chown terminal:terminal $RWORKDIR/terminal-mysql.tar.gz"
scp terminal:$RWORKDIR/terminal-mysql.tar.gz .
ssh terminal rm $RWORKDIR/terminal-mysql.tar.gz
rm -rf /root/mysql
tar xf terminal-mysql.tar.gz
mv tmp/mysql mysql
rm terminal-mysql.tar.gz
docker stop terminal-mysql || true; docker rm terminal-mysql || true
docker run --name terminal-mysql -v /root/mysql:/var/lib/mysql -e MYSQL_ROOT_PASSWORD=terminal -d mysql:$MYSQL_VERSION-debian
sleep 2;
docker stop terminal-mysql || true; docker rm terminal-mysql || true
docker stop terminal-mysql-bash || true; docker rm terminal-mysql-bash || true
docker run -it --name terminal-mysql-bash -d --entrypoint=bash  -v /root/mysql:/var/lib/mysql mysql:$MYSQL_VERSION-debian
sleep 1;
docker cp $SRC_ROOT/deploy/copy_terminal_mysql_helper01.sh terminal-mysql-bash:/copy_terminal_mysql_helper01.sh
docker exec terminal-mysql-bash /copy_terminal_mysql_helper01.sh
docker stop terminal-mysql-bash || true; docker rm terminal-mysql-bash || true
docker stop terminal-mysql-stable || true; docker rm terminal-mysql-stable || true
rm -rf /root/mysql-stable
mv /root/mysql /root/mysql-stable
docker run --name terminal-mysql-stable -v /root/mysql-stable:/var/lib/mysql -e MYSQL_ROOT_PASSWORD=terminal -e MYSQL_ROOT_HOST="%" -p 3306:3306 -d mysql:$MYSQL_VERSION-debian
sleep 4;
echo "select 'mysql connection works'" | mysql -uroot -pterminal --host=127.0.0.1 --port=3306 terminal
