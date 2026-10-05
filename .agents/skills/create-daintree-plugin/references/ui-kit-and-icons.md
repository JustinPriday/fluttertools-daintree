# UI Kit and Icons

Use this reference for visual plugins. The audited 0.41.0 host serves kit contract 1.0.0. Canonical `docs/plugins/ui-kit.md` gives exhaustive props; `shared/types/plugin-sdk-react.ts`, SDK `plugin-ui.d.ts`, the runtime facade and its pinned export list are the contract. Read matching target source instead of copying this release's full catalogue into a plugin.

## Choose the surface

| Need | Prefer |
| --- | --- |
| Controls and menus | Button/IconButton, host inputs/pickers, DropdownMenu/ContextMenu, Dialog/Popover |
| Settings | SettingsSection → SettingsGroup → SettingsRow; FormField for form-owned inputs |
| Small row list | ListRow and progressive rendering |
| Large list | VirtualList/GroupedVirtualList and stable keys |
| Grid or short ledger | DataTable: selection/grouping/editing/menus; virtualize=false for content-sized short tables; numeric columns and totals |
| Tree or structured value | TreeView/FileTree/ObjectInspector |
| Narrow pane layout | Stack/Cluster/AutoGrid/PaneLayout, MasterDetail/Inspector/Drawer, container queries |
| Dashboard hierarchy | Card, Heading, Figure/StatCard, status feedback and host charts |
| Code, diff or Markdown editing | CodeEditor/DiffView/MarkdownEditor; these do not grant fileEditors contributions |
| Reordering and board | SortableList/Kanban/DragDropProvider |
| Agent interaction | AgentPicker, SendToAgentButton, ContextDragSource; TerminalSnapshot displays supplied data |
| Workflow/record review | OperationStatus/ToolCallCard, StructuredDiff/DecisionRequest, attachments/citations |
| Custom diagram/canvas | Semantic tokens and theme API; do not force an unsuitable kit chart |

The kit handles native keyboard/focus/overlay behavior and theme changes. Prefer it for standard controls rather than recreating a host surface or bundling editor/grid/dnd/icon libraries. Custom content remains appropriate where the kit lacks the product behavior; lint warnings are heuristics, not a ban on legitimate custom visuals. SecretInput only edits a value: actual secrets still use declared host secret settings.

## Loading and compatibility

`@daintreehq/plugin-ui` has no npm runtime package. The host serves it through its import map and the preset externalizes it. Add SDK `/plugin-ui` to compilerOptions.types (or a reference directive) for ambient declarations. The matching workspace has `/view-globals` for typed browser bridge globals; it is also type-only. Published SDK 0.1.0 lacks both entries.

The host panel loader prepares activation, styles and lazy kit adapters before committing the view. Await `whenPluginUiReady()` in tests/custom measurement paths; failures can retry. `preloadPluginUi()` starts loading without awaiting it. Markdown loads separately and is not covered by kit readiness. Preserve plugin loading/error states.

Kit 1.0.0 is independent of Daintree 0.41.0 and SDK 0.1.0. Within a kit major, exports/props/accepted values/core theme tokens are not removed or narrowed; extended tokens may change with a minor and need fallbacks. <=0.40 serves Markdown only and no kit version. When deliberately supporting such a host, import a namespace and choose available exports: a missing named export fails linking before a guard can run. A new manifest toolbar key can fail an older strict parser even when the view has fallbacks; select a suitable artifact/minimum version.

Raw views can import host SDK `/react` on 0.41.0. Built views bundle their pinned hooks. Neither shape bundles the host UI kit. Raw views require relative shipped ESM for other dependencies and no uncompiled JSX; worker fallback imports are a separate Node mechanism.

## Portals, focus and theme

Kit overlays own their chrome; style the content you supply, not the host overlay shell. Kit content/Portal retains plugin style-root and owner attribution. A raw createPortal requires styleRootAttributes on its container. Use nested dialog layering inside another modal surface and verify focus restoration/keyboard access. Menus on clickable rows may need stopPropagation because React portal events bubble through React ancestors.

Use semantic theme utilities and container queries for the pane. Keep scroll ancestors min-h-0/min-w-0. Do not ship Tailwind preflight, stock palette classes, @apply or viewport-driven panel layout. Read getDaintreeTheme/onDidChangeDaintreeTheme/useDaintreeTheme for canvas/WebGL; core tokens are stable, extended terminal/syntax/activity/category tokens need a fallback. Keep accent to one meaningful signal per region.

## View icons versus manifest icons

View Icon and component icon props accept PluginIconSource: kit names, any valid Lucide kebab-case name, or your own element. Kit names render immediately; other Lucide names load lazily with a fixed-size placeholder. Invalid names draw nothing and warn in development. Use currentColor for custom glyphs. No lucide-react dependency is needed. An inline SVG may trigger heuristic lint but remains a supported custom source.

Manifest iconId accepts generic plugin registry IDs or `./icons/name.svg`. Arbitrary Lucide view names are not a manifest namespace. Assets are supported for panels, app toolbar buttons, process tools and nested panel-toolbar buttons; project-origin restrictions still apply to those contributions.

Paths must be lowercase POSIX relative SVG references, at most 64 characters, with no traversal/control characters/backslashes/URL syntax. Files are contained by realpath, bounded at 64 KiB, checked as UTF-8/single SVG root and sanitized. Supply xmlns and viewBox. The host draws a monochrome currentColor mask, so a multicolour brand SVG will not preserve its palette. Bad runtime assets fall back; current target CLI validation treats them as errors.

```json
{
  "id": "ledger",
  "name": "Ledger",
  "iconId": "./icons/ledger.svg",
  "color": "category-blue",
  "hasPty": false,
  "toolbar": [
    {
      "actionId": "acme.ledger.refresh",
      "iconId": "./icons/refresh.svg",
      "label": "Refresh",
      "status": true
    }
  ]
}
```

This is a panel contribution fragment; declare a matching view and register the own action. Confirm color/schema details on the target rather than treating a fragment as a whole valid manifest.

Include SVG files in distributed runtime assets. The audited packager's required-path check omits nested toolbar icon refs, although validation reads them: a `.dntrignore` exclusion can silently drop one. Inspect verbose dry-run and archive contents for every icon slot. Supplemental `audit_plugin.mjs --archive-files <json>` can compare custom refs to a JSON path list, but does not parse or accept a `.dntr` by itself. Project plugins need committed assets verified in a fresh checkout.

## Native header actions

Declare at most three own actions in a view panel's toolbar; actions receive panelId. Use usePanelToolbarItem for live status and useActionRunning for host-tracked handler runs. The header already draws busy while a handler runs from any entry point. State persists across ordinary remounts and resets on reload/close; retired setters do nothing. A surface/settings/dialog has no header setter, so draw a body fallback. Track resource-specific jobs in the worker; do not equate plugin-wide runningActions with a per-record lock.
