## Перелік месенджерів
- [gdocs: ЕХО](https://docs.google.com/spreadsheets/d/17mDPD0OM6HjXteMElScK0sT6jiOyS6C2Ic3i62NBRds/edit?gid=0#gid=0)  
  
## Діагностування 

 З таблиць ECHO-IM отримуємо інформацію про параметри підключення джерела

- таблички echo im
    - datasource
    - echo_client_lock
    - echo_client_config
        - порт
        - назва воркера systemd
        - папка з атачментами

```sql
select
    cl.id,
    cl.client_id,
    cc.process_name,
    cc.signal_api_attachment_path,
    cc.signal_port
from
    echo_client_lock cl
inner join echo_client_config cc on
    cl.client_id = cc.client_id
where
    cl.id = 7 -- client_lock_id з таблиці datasource
```

- signal cli rest api діагностика:
    - `curl http://localhost:8010/v1/accounts ; echo`
        - глянути чи прив'язаний акаунт
    - `journalctl -u echo-signal-bot@pivnich-signal -f`
        - глянути чи показує банер з ендпойнтами -- значить вбивається
  
## Прив'язка

- чистимо в середині папок data та attachments
```
root@echo-pivnich:/etc/echo/signal-cli-data/pivnich-signal/signal-cli# rm -rf ./data/*
root@echo-pivnich:/etc/echo/signal-cli-data/pivnich-signal/signal-cli# rm -rf ./attachments/*
```
- генеруємо QR-код для прив'язки та скануємо його потрібним пристроєм
    - зараз:
        - `ssh -nNT -L 8012:localhost:8012 echo-pivnich`
        - відкриваємо http://localhost:8012/v1/qrcodelink?device_name=pivnich-signal-5nov25
    - майбутнє: веб інтерфейс

### Troubleshoot 5NOV25

- знаходимо echo_client_lock.id=15, client_id=10
- прив'язка

**другий**

- echo_client_lock_id=7, client_id=7, account_id=6
    - echo-signal-bot@pivnich-signal
    - /etc/echo/signal-cli-data/pivnich-signal/signal-cli/attachments/
    - 8010

- [ ] сержант моніторинг задокументувати
- [ ] **p1** todo: чому нема нотифікації коли від'їбнув сигнал