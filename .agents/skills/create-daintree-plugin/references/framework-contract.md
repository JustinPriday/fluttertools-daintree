# Framework Contract

Use this reference while designing a manifest or worker main. Verify exact shapes against the target Daintree release.

## Lifecycle

1. Daintree discovers a directory whose name matches `plugin.json.name`.
2. It strictly validates the manifest and compatibility range.
3. It eagerly registers declarative contributions.
4. It lazily imports `main` and calls `activate(host)` on first use unless explicitly activated earlier.
5. It tears down registrations, calls plugin cleanup, and kills the third-party worker on unload.

Activation has a short timeout. Register quickly and defer expensive work.

Registrations and subscriptions must be created during activation. Queries, dispatch, storage, panel push, filesystem/Git calls, clipboard access, and process spawning are lifetime operations. Await asynchronous host calls and retain disposers.

Third-party main code runs in an out-of-process Node worker. It is cleanly reclaimed at unload but is not sandboxed from Node APIs.

## Manifest rules

- `name` is a scoped ID such as `publisher.plugin-name`.
- Directory name must match `name` after installation.
- `version` is semantic versioning.
- `engines.daintree` must match the runtime.
- Manifest validation is strict; unknown fields fail.
- Contribution IDs are bare and namespaced by Daintree.
- Action references are fully qualified.
- Duplicate IDs in a contribution array fail.
- A view ID must match a panel ID.
- View paths must be safe plugin-relative browser ESM paths.
- `location: "panel"` is the current view surface.
- Plugin PTY panels are not available.

Use manifest-declared commands even when registering their handlers imperatively, so they appear before activation. A convention handler is compiled JavaScript and receives only action arguments. Use `registerAction()` when a handler needs `host`.

## Panel contract

A panel and its view use the same bare ID. Daintree supplies the standard pane header and lifecycle on version 0.28 or newer. The view receives:

- `panelId`: runtime panel-instance identity;
- `pluginId`: manifest identity;
- `initialArgs`: save/restore-surviving binding arguments; and
- `disposeSignal`: renderer teardown notification; and
- `panelRemovedSignal`: terminal panel-record removal notification.

Use `host.onDidChangePanelLifecycle()` in the worker to release durable resources on `removed`; temporary view unmounts and trashed-but-restorable panels are not terminal. Use `setPanelBadge()` for supported native title status. Do not depend on arbitrary native header controls.

## Authority

Declare only needed capabilities and scopes. Important examples include shell execution, filesystem/Git access, clipboard, and agent access.

Filesystem scope tokens:

```json
{
  "scopes": {
    "fs": {
      "allowedPaths": ["${project}", "${worktree}", "${worktree}/generated"]
    }
  }
}
```

The tokens are validated, expanded at call time, and fail closed without matching context.

Capabilities are not a general Node sandbox. Host-mediated filesystem, Git, clipboard, and process operations are valuable because they are constrained and/or audited even though trusted worker code can use Node directly.

## Public APIs to prefer

- `registerAction`, `registerHandler`
- `dispatch`, `actions.list/get/canDispatch`
- `postToPanel`, `setPanelBadge`
- worktree snapshots and change subscriptions
- settings and private storage
- quick pick, input, confirmation, and toast helpers
- managed processes
- scoped filesystem and Git
- text and bounded PNG clipboard writes
- scoped system open/reveal for project, worktree, and private plugin-data files
- plugin logger
- MCP, agents, forge, and file decorations when the product matches them

Do not import Daintree implementation modules. If a required behavior is not in the public SDK/action catalog/manifest, treat it as a possible portal gap.

## Worktree context

Worker `getActiveWorktree()` is global host state. In multi-project use it may not represent the project visible in the renderer. For context-bound panel creation:

1. use an applicable public renderer-scoped action such as `worktree.getCurrent`;
2. match it to public worker snapshots;
3. ask the user if still ambiguous;
4. store stable binding data in `initialArgs`; and
5. revalidate it when restored.

Never silently retarget a restored panel because active context changed.

## Settings and storage

- Settings are user-visible and manifest-declared.
- Secret settings use the host's secure storage when available, with documented platform fallback.
- Private storage is for plugin-owned state and is plaintext.
- Storage scopes resolve against live context at call time.
- Never store credentials in private storage.

## Trust and release

Treat installed plugins as trusted code. Sideloaded plugins do not currently provide publisher authenticity comparable to signed marketplace distribution. Hashes protect archive integrity/update identity, not author identity.

Set the minimum Daintree version from required behavior, not from the version used on the developer machine.
