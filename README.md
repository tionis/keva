# KeVa
Keva is a simple data backend for small scripts and snippets around my personal infrastructure.  
It exposes the following features
- a regex based token system with different namespaces for different features
- a ntfy endpoint to send the sysadmin notifications
- a key value json document database that supports optimistic locking and JSON patch style document modification
- a patch endpoint that works similar to [patchbay.pub](https://patchbay.pub)/[patchwork](https://github.com/tionis/patchwork), but with token authentication
- a ping endpoint for dead Man Switches that trigger a sysadmin notification
- some "serverless" functions for my personal use

Keva was built in a way that it can be used both standalone or on Deno Deploy, mainly as an experiment for me and easier hosting. Especially as it monitors other services and a such should be independant of my other infrastructure.
