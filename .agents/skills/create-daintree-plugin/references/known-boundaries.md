# Known Boundaries

These findings were established while building a production panel plugin. Revalidate them against the target Daintree release before relying on them or reporting them.

## Current Daintree 0.29 boundaries

### Native panel header actions

Plugins can set a native badge. They cannot declare arbitrary dynamic native header controls based on selected resource state. Put feature controls in the view body unless Daintree adds a public contribution point.

### Push backpressure

`postToPanel` is targeted fire-and-forget without acknowledgement. Batch sustained output, bound memory, sequence messages, and provide resnapshot/reconnect. Measure actual throughput before requesting a stream portal.

### Managed process interaction

Managed pipe processes expose separate worker-readable stdout/stderr but keep stdin closed. Managed PTY processes expose writable input and resize but merge output streams and may change child terminal behaviour. Protocol clients that need bidirectional structured pipes must prove PTY compatibility or retain a narrowly documented direct-process adapter.

Do not state the current concurrency cap as a permanent API promise.

### Raw local sockets

There is no dedicated local-socket capability token. Trusted worker code can connect through Node, but that access is outside the host-mediated audit/scope model. Document and minimize it.

### Icons

Manifest validation already warns for unknown panel/view icon IDs and reports supported choices. Documentation and renderer registries may still differ, and custom plugin icon assets are not a general public contribution surface.

### Split development watchers

The dev command may watch only the default renderer config. A separately configured worker build needs its own watcher.

### Renderer module caching

Production Chromium ESM records are URL-cached. Use a versioned view filename. A host Force Reload can diagnose/recover, but is not a substitute for versioned release assets.

## Implemented features often mistaken for gaps

- `${project}` and `${worktree}` filesystem tokens are validated, expanded at call time, and fail closed.
- `useHostChannel` sends every call; a superseded call finishes transport work but resolves to `undefined`, while its stale error/state updates are ignored.
- Daintree 0.28 routes plugin panels through standard pane chrome and click-to-focus behavior.
- Icon validation already reports unrecognized IDs.
- Daintree 0.29 makes every panel kind dockable by default.
- `host.onDidChangePanelLifecycle` distinguishes temporary hiding from terminal panel removal.
- `host.clipboard.writeImage` provides bounded, audited PNG clipboard writes.
- `host.system.openPath` and `showItemInFolder` include the caller's private plugin-data namespace.
- Manifest commands and runtime actions accept per-action `requires` capability intent.

## Historical compatibility findings

Do not list these as present framework gaps without reproducing them on the target release:

- Daintree 0.26's React import-map/export failure was resolved in 0.27.
- The plugin panel missing-chrome/focus bug was resolved in 0.28.
- An older Electron/yauzl archive extraction stall around large compressed entries was triaged as host-owned; current builds must be retested rather than assumed affected.

## Reporting a new boundary

Before asking Daintree for a host change:

1. State the product behavior in user terms.
2. Cite the documented API attempted.
3. Build the smallest practical spike.
4. Measure load, ordering, and lifecycle needs.
5. Separate host behavior from plugin defects.
6. Create a generic reproduction without private archives or code.
7. Ask for the smallest stable public portal.
8. Explain why a plugin-side workaround would be unsafe, misleading, or dependent on internals.

Keep the framework concern separate from the plugin product pitch. Daintree developers need the reusable contract problem, not confidential product details.
