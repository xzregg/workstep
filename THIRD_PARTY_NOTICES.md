# Third-party notices

WorkStep depends on open-source packages under their respective licenses. Each desktop Release includes a CycloneDX dependency inventory generated from the hash-locked Python requirements and exact Yarn lockfile resolutions. Packaged Python and Electron distributions retain their own license metadata; `LICENSES.chromium.html` and package-specific license files remain part of their respective payloads where supplied upstream.

- Qoder Agent SDK and Qoder services are provided under the [Qoder Product Service Agreement](https://qoder.com/product-service). They are not bundled or installed by default and are not covered by WorkStep's Apache-2.0 license.
- Codex, Claude, and other providers may require their own accounts, credentials, subscriptions, and acceptable-use compliance.

Mention of a third-party product does not imply endorsement, affiliation, or transfer of trademark rights.

## Agency Agents role prompts

The bundled role center includes 282 role prompts from [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents), commit `bd956db032d907387e6b9ddebff3e18f1de8c679`, under the MIT License. Copyright (c) 2025 AgentLand Contributors. The original license is retained in `apps/daemon/data/role-center/LICENSE.agency-agents.txt` and distributed with the daemon data directory. Each role retains its repository, original file path, commit, and license identifier.

The Release SBOM is the version-specific dependency index. Review it together with the license files embedded by upstream packages before redistributing a modified binary.
