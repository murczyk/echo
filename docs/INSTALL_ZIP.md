Розгортання на голу машину з Убунту 22.04 робиться наступним чином:

```
$ just builder=echo-gpu server=$SERVER deploy-echo-install-package
$ ssh $SERVER
server$ cd /tmp/echo-install-package
server$ sudo ./echo-install
```

- Виконайте інструкції з [deploy/server.md](deploy/server.md) що залишились не зробленими
