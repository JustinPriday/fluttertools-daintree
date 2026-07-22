---
name: create-daintree-plugin
description: Design, scaffold, implement, test, package, review, or diagnose third-party Daintree plugins. Use for plugin.json manifests, Daintree commands, panels/views, toolbar entries, settings, MCP or agent contributions, @daintreehq/plugin-sdk host APIs, renderer-worker IPC, worktree-bound panels, .dntr packaging, production installation failures, and evidence-backed plugin framework gap reports.
---

# Create Daintree Plugin

Build against the documented public plugin contract, validate every renderer/worker boundary, and prove the packaged plugin in production Daintree. Prefer the smallest plugin shape and the narrowest host authority that delivers the product.

## Start with discovery

1. Read the repository's `AGENTS.md` and local instructions.
2. Inspect `plugin.json`, `package.json`, build configs, source entry points, tests, and existing `ai_docs/`.
3. Locate the canonical `docs/plugins/`, manifest schema, SDK types, and plugin tests for the Daintree version in scope.
4. Record the target Daintree version and whether authoring packages are published or locally linked.
5. Separate current framework behavior from historical workarounds in existing code or notes.

Use this source-of-truth order when facts conflict:

1. Target Daintree release and its runtime behavior.
2. Manifest schema and public SDK types in that release.
3. Daintree plugin tests and current implementation.
4. Canonical plugin documentation in the same checkout.
5. This skill's references and prior plugin implementations.

Read [Framework Contract](references/framework-contract.md) before changing a manifest or host integration.

## Classify the plugin

Choose one or combine only as required:

- Simple command: compiled lazy handler, no host APIs.
- Host-aware command: manifest contribution plus `registerAction()` during activation.
- Visual workspace: paired panel/view plus a worker main.
- Live integration: visual workspace plus worker-owned connection and panel-targeted push events.
- Agent tooling: MCP server or agent contribution with declared authority.

Identify the durable product binding before coding: project, worktree, package root, service, device, session, or a composite identity. Do not use global active state as permanent panel identity.

If the user asks for a plan or spec, create it under the repository's documented AI-doc location before implementation. Keep host framework proposals separate from product specs.

## Design the contract

Define:

- scoped plugin ID and semantic version;
- real minimum Daintree version;
- contributions and fully-qualified action references;
- capabilities and filesystem/network scopes;
- renderer and worker entry points;
- panel `initialArgs` schema and restore rules;
- typed request/response channels;
- push event shapes and panel targeting;
- ownership and teardown for every process, socket, watcher, timer, and stream;
- expected sustained messages/bytes per second; and
- production acceptance environment.

For a context-required panel, set `showInPalette: false`. Open it from a command or toolbar action that resolves current context, then dispatch `panel.openPluginPanel` with stable `initialArgs`, `worktreeId`, and an explicit `reuseExisting` policy.

Do not invent unsupported manifest fields. Unknown keys and invalid cross-references fail strict validation.

## Implement by runtime

### Worker main

- Keep `activate(host)` fast.
- Await registrations and subscriptions during activation.
- Use typed `registerHandler()` overloads with runtime schemas.
- Defer heavy discovery and connections until first use.
- Prefer audited host APIs over raw Node access.
- Return idempotent cleanup for plugin-owned resources.
- Retain explicit per-panel resource ownership even though worker lifetime is plugin-wide.

### Renderer view

- Render only the panel body; Daintree owns title chrome, focus, move, maximize, context menu, and close behavior.
- Accept and validate `PanelViewProps`, including `panelId`, `initialArgs`, and `disposeSignal` where relevant.
- Use real controls with hover, focus, disabled, busy, and error states.
- Ensure nested flex/scroll regions use `min-height: 0`, and test narrow and short panels.
- Never import Daintree internals or reconstruct host chrome.

### Build

- Use separate browser and Node builds when the plugin has a view and a worker.
- Use `@daintreehq/plugin-vite`.
- Externalize all React and React DOM entry points from the renderer.
- Emit a versioned renderer filename and keep `plugin.json` synchronized.
- Ensure the worker's runtime dependencies are bundled or shipped.
- Arrange a second watcher when Daintree's dev command watches only the default config.

Read [Panels and Transport](references/panels-and-transport.md) for IPC, sustained output, binding, layout, and live-tail patterns.

## Choose the correct transport

- Use typed `useHostChannel` request/response for snapshots and user-triggered operations.
- Every overlapping invocation is still sent; only the latest can update hook state and return its result. A superseded invocation finishes transport work but resolves to `undefined`. This is not cancellation or a streaming protocol.
- Use `postToPanel(..., panelId)` plus a panel-targeted subscription for live events.
- Batch sustained output by time and size, sequence batches, keep bounded renderer history, detect gaps, and provide a snapshot/reconnect path.
- Serialize ordered mutations or queue them in the worker.
- Never broadcast high-volume instance state and rely on local filtering.

## Use host authority honestly

Prefer, in order:

1. documented Daintree action or host API;
2. structured library in the plugin worker;
3. supervised `host.process.spawn` for noninteractive processes;
4. direct Node APIs only when required behavior has no host path.

Do not describe capabilities as a Node sandbox. They disclose authority, influence host policy, and gate specific host APIs. Use `${project}` and `${worktree}` filesystem scope tokens when dynamic roots are appropriate; they are implemented and fail closed.

When direct Node access is necessary, document why, scope, data flow, teardown, and user diagnostics.

## Test and package

Run, in order:

1. typecheck and repository static checks;
2. strict manifest validation;
3. worker and pure renderer tests;
4. production builds for both runtime targets;
5. `scripts/audit_plugin.mjs <plugin-root>` from this skill;
6. verbose packaging dry-run;
7. archive-content inspection;
8. installation of the exact `.dntr` in production Daintree; and
9. lifecycle acceptance: focus, close, drag, maximize, restore, multiple panels, update, disable, and uninstall.

Package from a clean staging directory containing only `plugin.json` and required runtime artifacts. Do not commit `.dntr` archives; publish them as release assets.

Read [Testing and Release](references/testing-and-release.md) before claiming release readiness.

## Diagnose before patching

For production failures, capture:

- Daintree and plugin versions;
- exact manifest and built entry paths;
- renderer error and component stack;
- worker activation/log output;
- archive file list;
- whether dev mode and production differ;
- whether a clean restart, panel close/reopen, or Force Reload changes the result; and
- a generic reproduction that does not depend on private archives.

Common diagnoses:

- React export or `process is not defined`: renderer bundled React incorrectly.
- Old view after reinstall: unchanged module URL; version the view filename.
- Wrong worktree in multi-project use: global active state was treated as visible context.
- Cross-panel stream data: push events were not targeted by panel ID.
- Live-tail drift on resize: layout scroll was mistaken for user intent.
- Command visible but inert: no compiled lazy handler or imperative registration.

Use Force Reload as a diagnostic/recovery control, not as the intended upgrade flow.

## Handle framework boundaries

Read [Known Boundaries](references/known-boundaries.md) before proposing host changes.

Do not edit Daintree unless the user explicitly asks. Explore the documented route first. If it cannot meet the measured requirement, prepare a focused report containing:

- desired behavior and user value;
- documented API attempted;
- minimal generic reproduction;
- measured workload/lifecycle requirements;
- practical result;
- smallest public host portal that would unblock the plugin; and
- why a plugin-side workaround would be unsafe, private, or misleading.

Correct factual claims against the target release. In particular:

- `${worktree}` filesystem authority already exists;
- `useHostChannel` sends all calls but suppresses stale hook state;
- do not turn a current process cap into a promised API constant;
- icon validation already reports supported IDs;
- Daintree 0.28 supplies standard plugin panel chrome/focus; and
- resolved historical archive and React bugs are compatibility history, not current missing-framework items.

## Definition of done

The work is complete only when:

- the smallest viable documented contract is implemented;
- manifest, package, and built paths agree;
- runtime inputs and IPC outputs are validated;
- resource ownership and cleanup are deterministic;
- contextual panels restore to the same durable target;
- live data is targeted, bounded, and recoverable;
- UI survives normal panel lifecycle and resize;
- the clean archive contains only runtime artifacts; and
- the exact release artifact passes production Daintree acceptance.
