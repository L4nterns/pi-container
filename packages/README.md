# Pi package distribution snapshots

`pi-provider-gateway/` is the extracted, independently installable `pi-provider-gateway@1.0.0` release.
It is not implemented in pic's entrypoint or lifecycle scripts. The authoritative working source
is the separate `pi-provider-gateway` project; this directory contains its reviewed distribution files.

- Release archive: `pi-provider-gateway-1.0.0.tgz`
- SHA-256: `56a04d9d4ab96a4c82b0389a544dd74b2da66e141f98a93fd0d2c8e7950e27e4`
- License: MIT; included in the release.
- Pi runtime: pic follows npm `latest` without a Pi version pin; the actually tested release is recorded in `VALIDATION.md`. Node.js 24.

To update, test the independent project, run `npm pack --ignore-scripts`, review the archive,
replace this distribution directory, update the version in `config/pi-bootstrap.json`, and rebuild.
No bootstrap code changes or credential rewrites are required. An immutable npm/Git source with
an exact version/ref can replace the local source in the manifest if the package is published.
The current package has not been published to npm or pushed to a remote repository.
