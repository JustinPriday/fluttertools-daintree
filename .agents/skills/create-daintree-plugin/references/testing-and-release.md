# Testing and Release

## Static gate

Require:

- typecheck;
- strict manifest validation;
- `package.json.version === plugin.json.version`;
- manifest `main` and every view `componentPath` exist after build;
- paired panel/view IDs;
- valid fully-qualified action references;
- compatible `engines.daintree`; and
- renderer output free of bundled React.

Run `node <skill>/scripts/audit_plugin.mjs <plugin-root>` after building. Treat warnings as review prompts and failures as release blockers.

## Worker tests

Use the official testing package or a faithful mock host. Cover:

- fast successful activation;
- action/handler registration;
- cleanup after successful activation;
- schema failures;
- worktree ambiguity and stable binding;
- restored stale binding rejection;
- target-specific operations;
- per-panel session isolation;
- batching, byte/record limits, and sequence order;
- connection loss and retry;
- no stream/process/socket leakage after disposal; and
- capability failures.

## Renderer policy tests

Extract pure functions for:

- event reduction and bounded history;
- filtering;
- status and identity labels;
- sequence-gap detection;
- live-follow pause/resume decisions; and
- formatting copied/exported content.

Exercise loading, empty, offline, degraded, busy, success, and error states. If UI automation exists, test focusable controls and narrow/short panel layouts.

## Build gate

A panel plugin normally needs:

1. clean `dist`;
2. renderer build;
3. renderer React-bundle audit;
4. worker build without deleting renderer output; and
5. runtime entry audit.

If Daintree's dev tool watches one Vite config, use a second explicit watcher for the worker.

## Clean packaging

Do not package the repository root blindly. Create a temporary staging directory and copy only:

- `plugin.json`;
- required `dist/*.js`; and
- intentionally required runtime assets.

Run the standard Daintree packager in the staging directory. Run `--dry-run --verbose` first and inspect every path. Exclude source maps unless deliberately required for distributed diagnostics.

Keep `.dntr` files out of Git. Attach the exact accepted archive to the release.

## Production acceptance matrix

Install in the production Daintree version named by the compatibility range and verify:

- Plugin Manager identity/version/settings;
- palette command and toolbar/menu entry;
- context resolution and panel binding;
- native header, focus, Cmd/Ctrl+W, close, drag/reorder, maximize/restore;
- narrow and short layouts;
- empty and real target projects;
- multiple independent panel instances;
- destructive-operation confirmation and correct target identity;
- sustained live output, pause/resume, resize anchoring, reconnect;
- update from the previous version without stale renderer code;
- restart and saved-layout restoration;
- disable/uninstall cleanup; and
- supported OS-specific integration.

## Production diagnostics

Capture facts before changing code:

- Daintree version/build and operating system;
- installed and attempted plugin versions;
- plugin manager state;
- manifest and built entry names;
- renderer message/stack and worker log;
- exact archive file list and relevant generic entry sizes;
- result after panel reopen, Force Reload, and full restart;
- whether delete/install differs from replacement; and
- whether a minimal generic fixture reproduces it.

Do not give another team private archives or paths as required reproduction steps. Reduce host problems to generated fixtures or a small public sample.

## Common failure signatures

| Failure | Likely cause |
| --- | --- |
| React named export missing | Incompatible/bundled React module |
| `process is not defined` in panel | Node/CommonJS React branch in browser bundle |
| Old view after update | Reused component URL/module cache |
| Command entry does nothing | Missing lazy handler or failed activation/action registration |
| Panel has no context | Generic palette opened a context-required panel |
| Panel receives another instance's events | Broadcast rather than targeted push |
| Live following pauses during resize | Passive layout scroll treated as user scroll |
| Settings tabs empty | No settings/content contributed, or host version UI limitation |
| Install spinner never finishes | Host archive/installer issue; collect generic fixture and boundary evidence |

Force Reload is a useful renderer recovery control. It is not the desired routine install/update path.

## Release record

Record:

- plugin version and commit;
- minimum tested Daintree version;
- supported operating systems;
- archive checksum;
- archive contents review;
- automated check results;
- production acceptance result; and
- known host boundaries or direct Node authority.
