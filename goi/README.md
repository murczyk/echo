# GOI

deploy with `just deploy --server <server>`. 

it deploys 3 units:
- port 4000: process goi, data a /etc/goi
- port 4002: process swapp, data at /etc/swapp
- port 4003: process swapp-alt, data at /etc/swapp-alt; it's another swapp instance, useful if you need 2 separate accounts like JF (1 account sends from goi, 2nd reads messages and resends them to different chats) 

## New Version Release

- download new version like `goi-1.3.3.zip`, unzip under `goi/goi/goi-1.3.3`
- edit `justfile` `goi_version`
- run `just release`
