.PHONY: deploy
deploy:
	rsync -az -i --progress --exclude .git . root@stardust:/var/www/wd/ ;
	ssh root@stardust 'chmod a+r /var/www/wd/wdintel/*'
	echo "Ready. Now open https://wildducks.online"

