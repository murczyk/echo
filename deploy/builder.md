# Builder via Multipass

## SETUP

Example for 22.04:

```
$ multipass launch 22.04 --disk=10G --cpus 24 --memory 16G --name="builder-2204"
$ multipass shell builder-2204
[builder-2204]$ mkdir workspace
[builder-2204]$ cd workspace

# setup deploy keys

[builder-2204]$ echo "..." > ~/.ssh/id_echo.pub
[builder-2204]$ echo "..." > ~/.ssh/id_echo
[builder-2204]$ chmod 0600 ~/.ssh/id_*
[builder-2204]$ GIT_SSH_COMMAND="ssh -i ~/.ssh/id_echo" git clone git@github.com:echoua/echo.git echo
[builder-2204]$ cd echo
[builder-2204]$ git config core.sshCommand "ssh -i ~/.ssh/id_echo"
# if needed -- don't forget to initialize lfs
[builder-2204]$ curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | sudo bash
[builder-2204]$ git lfs pull
```
