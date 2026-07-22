# Panels and Transport

## Runtime split

Keep privileged integrations in the worker and interaction/rendering in the view.

```text
view -- typed invoke --> worker handler --> external service
view <-- targeted push -- worker subscription <-- external service
```

Use request/response for snapshots and explicit mutations. Use targeted push for live deltas.

## Typed request/response

Register Zod-backed channels:

```ts
await host.registerHandler(
  "device.select",
  { args: selectArgsSchema, result: selectedDeviceSchema },
  async (_context, args) => selectDevice(args)
);
```

The host validates inputs before the handler and results before returning them. Add channel capability requirements when appropriate.

`useHostChannel` invokes every call. If calls overlap, only the latest one changes `loading`/`error` and can return its result. A superseded invocation finishes its bridge/worker work but resolves to `undefined`; its error is ignored. Therefore:

- use it directly for infrequent user actions;
- debounce replaceable queries;
- serialize ordered mutations;
- use explicit operation IDs for long work; and
- never treat it as an ordered terminal/log stream.

## Targeted push

Push panel-owned events with the instance ID:

```ts
await host.postToPanel("run.output", batch, panelId);
```

Subscribe with a panel-targeted hook/bridge using the same `panelId`. Broadcasting is appropriate only for truly shared state.

Push has no acknowledgement and unmounted panels miss events. Maintain a snapshot endpoint or reconnectable source when correctness depends on recovery.

## Sustained output protocol

For logs, stats, tests, or device output:

- one worker-owned upstream session per intended resource owner;
- panel ID and durable binding attached to the session;
- time and byte/record batching;
- global sequence per panel feed;
- bounded renderer history;
- gap detection;
- reconnect/resnapshot command;
- explicit disconnect channel; and
- plugin-wide idempotent cleanup.

Measure peak and sustained messages/bytes per second. If targeted IPC cannot meet the measured load, report the result before requesting a backpressured stream API.

## Binding a contextual panel

Hide a context-required panel from the generic palette. A public action should:

1. resolve the visible worktree/project;
2. let the user choose if ambiguous;
3. create versioned binding arguments;
4. dispatch `panel.openPluginPanel` with `kind`, `worktreeId`, `initialArgs`, and `reuseExisting`;
5. persist any per-panel override; and
6. refresh badge and initial snapshot.

Validate restored bindings against current public worktree snapshots. Do not trust arbitrary renderer arguments to authorize external control.

Model identities separately. Depending on the product, show worktree, package/project root, external project/session, service/process, and selected target/device.

## Panel lifecycle

Daintree 0.28+ provides the native header, focus, drag/reorder, maximize, context menu, and close behavior. The plugin view supplies the body.

The public worker contract is plugin-lifetime oriented. Do not assume a permanent panel deletion callback exists. Combine:

- renderer `disposeSignal` and effect cleanup;
- explicit disconnect when the view unmounts;
- idempotent worker session replacement;
- inactivity/lease cleanup when appropriate; and
- final plugin cleanup.

The renderer may unmount for backgrounding or resource pressure and later restore. Decide whether external work should stop, pause, or continue, and encode that behavior explicitly.

## Layout

For every flex ancestor that contains a scroll area, set `min-height: 0` and usually `min-width: 0`. A dependable scroll child uses:

```css
.scroll-region {
  height: 0;
  min-height: 0;
  flex: 1 1 0;
  overflow: auto;
}
```

Test after adjacent panels are added/removed, maximize/restore, and at narrow/short dimensions.

## Live tail

Do not interpret every scroll event as user intent. Layout changes and programmatic `scrollTop` updates also emit scroll.

Track intent from wheel, touch, pointer, or navigation keys. Only an intentional move away from the bottom should pause following. While following:

- scroll after new content;
- observe viewport resize and re-anchor;
- schedule DOM reads/writes with `requestAnimationFrame`; and
- show an explicit Resume live tail action when paused.

## Renderer build

Use `@daintreehq/plugin-vite`. Externalize all React/React DOM specifiers. Check the output contains bare host React imports and does not contain `node_modules/react` or React's `process.env.NODE_ENV` branch.

Version the renderer filename, for example `panel-0.2.0.js`, and update the manifest on every release. Chromium caches module records by URL and production reinstall cannot evict them.

## UI quality

- Use actual buttons, not clickable text.
- Provide accessible labels/tooltips for icon buttons.
- Show disabled and busy states during operations.
- Keep errors local and actionable.
- Supply empty states for no target, disconnected target, and target with no items.
- Show the identity the operation will affect before destructive actions.
- Do not recreate Daintree's native pane title bar inside the view.
