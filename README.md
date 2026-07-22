# Flutter Tools for Daintree

Worktree-aware Flutter development tools inside [Daintree](https://github.com/daintreehq/daintree).

Flutter Tools gives each Daintree worktree a persistent Flutter cockpit. Discover nested apps and connected devices, run and control several device sessions, inspect live output, open DevTools, and capture screenshots without switching to another IDE.

> **Made in Daintree.** Flutter Tools was authored entirely inside Daintree—a plugin built from within the environment it extends.

> [!IMPORTANT]
> Flutter Tools is preparing for its first public prerelease. Interfaces and installation details may change while the Daintree plugin framework evolves.

## Why Flutter Tools?

Flutter tooling normally revolves around an IDE window and its current launch target. Daintree revolves around projects and worktrees. Flutter Tools connects those models:

- The panel belongs to a specific Daintree worktree.
- A discovered Flutter app is bound independently within that worktree.
- Each detected device retains its own run state and console history.
- Restored panels keep their original worktree binding instead of following whichever worktree becomes active later.

This is especially useful when several worktrees run different revisions of an app—or when one panel controls several Flutter targets at once.

## Features

- Bounded discovery of Flutter apps nested within the owning worktree.
- Flutter SDK resolution from plugin settings, a worktree-local FVM SDK, or `PATH`.
- Live physical-device, emulator, simulator, desktop, and web target discovery through `flutter daemon`.
- Independent debug sessions for multiple devices in one panel.
- Run, Stop, Detach, Hot Reload, and Hot Restart controls.
- Structured per-device console with bounded history, filtering, copy, clear, and follow-tail controls.
- Session-specific Flutter DevTools launch inside Daintree's browser.
- Device screenshot capture, preview, deletion, system opening, and best-effort image copying.
- Persistent worktree and Flutter-project binding across panel restoration.
- Native Daintree panel focus, drag, reorder, maximise, close, and status badges.

## Requirements

| Requirement | Current support |
| --- | --- |
| Daintree | 0.28.0 or newer |
| Node.js for development | 22.13.0 or newer from the Node 22 release line |
| Flutter | A locally installed SDK available through settings, `.fvm/flutter_sdk`, or `PATH` |
| Flutter project | A `pubspec.yaml` with a Flutter SDK dependency inside the bound worktree |
| Host OS | macOS first; other Flutter desktop hosts are not yet acceptance-tested |

Available targets and operations depend on the installed Flutter SDK and the capabilities Flutter reports for each device. Screenshot capture is enabled only for devices that advertise screenshot support.

## Installation

When the first prerelease is published:

1. Download `justinpriday.flutter-tools-<version>.dntr` from the repository's Releases page.
2. In Daintree, open **Preferences → Plugins**.
3. Choose **Install from file…** and select the archive.
4. Review and approve the requested process, filesystem, and clipboard permissions.
5. Run **Flutter: Open Tools** from the Command Palette or use the Flutter Tools toolbar action.

No package is installed into your Flutter application. Flutter Tools uses your existing local Flutter SDK and project files.

## Using Flutter Tools

Opening Flutter Tools binds the panel to the visible worktree. The plugin searches that worktree for Flutter projects and resolves a Flutter SDK. If more than one app is found, choose the app from project settings in the panel header.

- Select a target from the device picker, then choose **Run** to start a debug session.
- Switch devices without stopping sessions already running on other targets.
- Use **Hot Reload** or **Hot Restart** when the selected debug target supports it.
- Filter, copy, or clear the selected device's console. Scroll upward to pause follow-tail, then choose **Resume live tail** to return to current output.
- Open the connected session in Flutter DevTools after its VM service becomes available.
- Capture a screenshot when the selected device supports it, then preview, open, copy, or delete the saved PNG.
- Choose **Detach** to leave the app running while ending the Flutter tool connection.

Run, Stop, Detach, Hot Reload, and Hot Restart act on real local Flutter processes. Confirm that the selected project and device are correct before interrupting a session.

## Permissions and trust

The manifest declares:

- `shell:exec` for Flutter daemon and run processes, plus opening plugin-owned screenshots.
- `fs:project-read` to discover Flutter projects within the current project or worktree.
- `fs:user-data-write` to save and delete captured screenshots.
- `clipboard:write` to copy console text.

Flutter's machine protocols require bidirectional standard input and output, which Daintree 0.28 does not expose through its managed process API. The plugin worker therefore starts fixed Flutter commands directly with argument arrays and `shell: false`. It also uses a fixed operating-system command to open only screenshots inside its own data directory.

Image clipboard support is best effort because Daintree's public plugin clipboard API currently supports text only. A failed image copy is reported in the panel; opening the saved PNG remains available.

Flutter Tools does not include telemetry or a remote service. Flutter command output and screenshots remain local to the Daintree plugin process and its user-data directory.

## Architecture

```text
Daintree panel (React)
    ↕ validated plugin channels and targeted panel events
Plugin worker (Node.js)
    ↕ JSON-lines machine protocols
Flutter daemon and Flutter run processes
    ↕
Local devices, emulators, simulators, desktop, and web targets
```

- The React bundle owns presentation, selected-device views, bounded rendered output, filtering, screenshots, and user interaction.
- The Node worker owns worktree bindings, project discovery, SDK resolution, Flutter processes, per-device sessions, and persisted screenshot files.
- Zod schemas validate renderer-to-worker requests, worker responses, and pushed console batches.
- Each panel has independent runtime state; each device has an independent run session and console buffer.

## Development

The current source setup expects a Daintree checkout at `../../Daintree` because the SDK, testing helpers, Vite preset, and CLI are referenced through local `file:` dependencies.

```text
Developer/
└── Electron/
    ├── Daintree/                    # Daintree v0.28.0 or compatible newer checkout
    └── DaintreePlugins/
        └── FlutterDaintree/         # this repository
```

Prepare Daintree first:

```sh
cd ../../Daintree
git checkout v0.28.0
npm install
npm run packages:build
```

You may use a newer compatible checkout, but plugin framework changes can affect the build. Return to this repository, verify the expected layout, and install the locked dependencies:

```sh
cd ../DaintreePlugins/FlutterDaintree
test -f ../../Daintree/packages/plugin-sdk/package.json
node --version
npm ci
```

Run the project checks:

```sh
npm run typecheck
npm test
npm run layout:verify
npm run build
npm run validate
npm run audit
```

Create the production archive and checksum with the complete release gate:

```sh
npm run release:prepare
```

The artifacts are written to the repository root:

```text
justinpriday.flutter-tools-<version>.dntr
justinpriday.flutter-tools-<version>.dntr.sha256
```

Inspect the exact archive selection without keeping an archive:

```sh
npm run package:dry-run
```

Update every version-bearing manifest consistently:

```sh
npm run version:set -- <version>
```

After committing and pushing a clean release commit, create a draft GitHub release with the tagged archive and checksum:

```sh
npm run release
```

Run `npm run release -- --help` for prerelease, release-notes, and immediate-publish options. Draft releases are the default so the final assets and notes can be reviewed before publication.

## Repository guide

```text
src/index.ts                 Node plugin worker and host registrations
src/panel.react.tsx          Flutter Tools React view
src/panelStyles.ts           Panel design system and responsive layout
src/flutter/                 Flutter discovery and machine-protocol adapters
src/shared/                  Validated contracts and bounded console state
tools/                       Deterministic build, packaging, and release helpers
```

## Current limitations

- macOS is the only fully acceptance-tested host platform.
- Flutter projects must currently live inside the bound Daintree worktree.
- The panel currently launches debug mode with Flutter's default entrypoint and arguments.
- Emulator and simulator creation or launch is not included; start them with existing platform or Flutter tools.
- Attaching to an app started outside Flutter Tools is not included.
- Screenshot availability is device-dependent, and image clipboard copying is best effort.
- Screenshots are kept in the current panel view only until it unmounts, though their PNG files remain in plugin user data until deleted.
- Hidden panels retain active resources through a bounded reconnect lease because Daintree 0.28 does not distinguish temporary view unmount from permanent panel deletion.
- Daintree treats every action from a plugin with process or write authority as confirmation-worthy, so opening Flutter Tools may display a capability confirmation.

## Project identity

- Product: **Flutter Tools for Daintree**
- In-app name: **Flutter Tools**
- Plugin ID: `justinpriday.flutter-tools`
- Panel: **Flutter Tools**

Flutter and Dart are trademarks of Google LLC. Flutter Tools for Daintree is an independent project and is not affiliated with or endorsed by Google LLC.

## Contributing

Bug reports and focused pull requests are welcome, particularly for reproducible Flutter SDK discovery, machine-protocol, device lifecycle, console streaming, screenshot, and Daintree panel-lifecycle issues. Include the Daintree version, host OS, Flutter version, target type, and whether the problem survives a Daintree Force Reload.

## License

Flutter Tools for Daintree is licensed under the [Apache License 2.0](LICENSE).
Bundled dependency licenses and attributions are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and included in every
installable `.dntr` archive.
