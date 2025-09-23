## Встановлення (apt repo)

- Попередньо
    - Поставте Ubuntu 22.04 з юзером ubuntu (бажано)
    - sudo apt-get -y install openssh-server
    - Поставте tailscale `curl -fsSL https://tailscale.com/install.sh | sh`
    - Потім `sudo tailscale up`
    - На сайті tailscale також в меню переіменуйте машину типу echo-operator-<ваш-підрозділ>
    - На сайті tailscale в меню зробіть disable key expiry
    - На сайті tailscale згенеруйте інвайт (share)
- Переконайтесь що ви бачите `echo-ci.eagle-atria.ts.net` (`ping echo-ci.eagle-atria.ts.net`)
    - Якщо ні -- запросіть свого юзера
- Додайте apt-репо (HTTPS + підписаний ключ)

```
sudo apt-get install -y curl
sudo curl -fsSL https://echo-ci.eagle-atria.ts.net/keys/echo-ci-archive-keyring.gpg \
  -o /usr/share/keyrings/echo-ci-archive-keyring.gpg
ARCH=$(dpkg --print-architecture)
echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/echo-ci-archive-keyring.gpg] \
https://echo-ci.eagle-atria.ts.net/echo jammy main" | \
  sudo tee /etc/apt/sources.list.d/echo.list
sudo apt-get update
sudo apt-get install -y echo-install
sudo echo-install install
```

    - Альтернатива: якщо потрібно самостійно згенерувати keyring через ASCII-ключ,
      виконайте окремо:

```
curl -fsSL https://echo-ci.eagle-atria.ts.net/keys/echo-ci-archive-keyring.asc | \
  sudo gpg --dearmor -o /usr/share/keyrings/echo-ci-archive-keyring.gpg
```
