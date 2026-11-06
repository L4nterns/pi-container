---
name: app-deployment
description: Configure application environments and deploy, debug, operate or remove applications in the independent service container over SSH and SFTP. Use when the user requests application deployment or service administration.
---

# Application deployment and operations

Read `/opt/pic/DEPLOYMENT.md` before acting. Connect using `ssh app-services`; transfer reviewed artifacts with `sftp app-services` or `scp`. All projects in this installation share management access. Inspect existing applications before choosing names or changing shared dependencies.

The service is a Debian environment, not a language-specific deployment platform. Inspect installed tools and install the runtime and system dependencies the application actually requires. Container administration and application execution are different roles: never run the application as root. Never request Docker socket access or modify host services.

Record repeatable environment preparation in the persistent service directory; an interactive installation alone does not survive container recreation. The administrator HOME `/home/deploy` is disposable staging, not automatically durable state. Persist only identified application data, reviewed runtime artifacts, required configuration and identities; restore reproducible dependencies from setup scripts. Keep application artifacts, persistent business data, supervisor definitions and gateway configuration separate. Do not upload repositories wholesale, credentials, development configuration or unrelated files.

Use Supervisord for foreground applications and crash recovery. `supervisorctl stop` alone does not persist the stopped state: save `autostart=false` and reread/update the definition. Use the reviewed examples in `examples/python/` as a starting point, adapting name, fixed UID, port and runtime; they do not limit supported application languages. The administrator has unrestricted container sudo; never confuse that with the permissions of application processes. Validate gateway configuration before reload, then check that requests reach the intended application. Internal health is not public verification; if a public URL is configured, inspect HTTPS, assets and business endpoints too. Do not claim zero downtime or automatic database rollback.

Stopping preserves application data. Permanent deletion requires explicit user authorization and an appropriate backup; identify and remove only the selected application's processes, definitions, files and account. Do not erase shared configuration or other applications. Never disclose SSH keys, tokens, application secrets or raw private logs.
