# Container operation rules

- Every shell command that can block must set a `timeout` in seconds. The `tool-policy` extension supplies 120s when omitted; explicit values above 600s are long tasks and above 3600s are capped.
- Never run `git grep` in a blobless/partial clone. It triggers lazy blob fetches and can look frozen for a long time. Use `git show HEAD:<path>`, a sparse checkout, or the GitHub API/raw URL instead.
- Bound network probes too: `curl -m`, `ssh -o ConnectTimeout`, and `timeout N`.
- These rules protect the agent loop; they do not change provider retry or model routing. Fallback belongs upstream (for example Magpie), never in this container.
