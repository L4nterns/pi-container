# pi-tool-policy

Container-level shell safety for Pi.

- A `bash` or `powershell` call without `timeout` gets a **120 second** default.
- Explicit timeouts are capped at **3600 seconds**; values above 600 seconds produce a warning.
- A footer status shows elapsed time and time since the last output for running shell calls, so a silent command is visibly still running instead of looking frozen.
- The cap is deliberately not a fallback: it only bounds a single tool execution. Provider/model retries remain Pi's responsibility.

The extension is loaded directly from `/opt/pic/extensions/tool-policy/src/index.ts` by `pic-entrypoint`; it is not a model provider and never changes requests.
