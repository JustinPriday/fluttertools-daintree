# Flutter Tools for Daintree

Worktree-aware Flutter development tools inside [Daintree](https://github.com/daintreehq/daintree).

Flutter Tools gives each Daintree worktree a persistent Flutter cockpit. Discover nested apps and connected devices, run and control several device sessions, inspect live output, open DevTools, and capture screenshots or Android screen recordings without switching to another IDE.

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
- Run, Stop, Detach, Hot Reload, Hot Restart, and confirmed Reinstall & Restart controls.
- Structured per-device console with bounded history, filtering, copy, clear, and follow-tail controls.
- Session-specific Flutter DevTools launch inside Daintree's browser.
- Unified Media view for screenshots and Android screen recordings.
- Device screenshot capture, preview, deletion, scoped system opening, and native image copying.
- Physical Android screen recording with elapsed state, automatic three-minute completion, and safe finalization across panel/device lifecycle changes.
- Optional save folder for new PNG and MP4 captures, with private Flutter Tools storage as the fallback.
- Persistent worktree and Flutter-project binding across panel restoration.
- Native Daintree panel focus, drag, reorder, maximise, close, and status badges.

## Requirements

| Requirement | Current support |
| --- | --- |
| Daintree | 0.29.0 or newer |
| Node.js for development | 22.13.0 or newer from the Node 22 release line |
| Flutter | A locally installed SDK available through settings, `.fvm/flutter_sdk`, or `PATH` |
| Android recording | Android SDK Platform Tools (`adb`) available through `ANDROID_SDK_ROOT`, `ANDROID_HOME`, a standard SDK location, or `PATH` |
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
- Long-press **Hot Restart** to confirm **Reinstall & Restart**, which permanently removes all app data stored on the Android or iOS device before launching the same run configuration.
- Filter, copy, or clear the selected device's console. Scroll upward to pause follow-tail, then choose **Resume live tail** to return to current output.
- Open the connected session in Flutter DevTools after its VM service becomes available.
- Capture a screenshot when the selected device supports it, then preview, open, reveal, copy, or remove the saved PNG.
- On a selected Android target, choose **Record** and then **Stop** to save an MP4. The control shows elapsed time while recording.
- In Daintree plugin settings, optionally set **Capture save folder** to Desktop, Downloads, or another existing directory. Each new PNG or MP4 is saved once, directly there. When empty or unavailable, Flutter Tools uses its private storage instead.
- Choose **Detach** to leave the app running while ending the Flutter tool connection.

Run, Stop, Detach, Hot Reload, Hot Restart, and Reinstall & Restart act on real local Flutter processes. Reinstall & Restart requires confirmation because it removes the selected device's installed app and local data.

## Permissions and trust

The manifest declares:

- `shell:exec` for Flutter, ADB, and Android `screenrecord` processes.
- `fs:project-read` to discover Flutter projects within the current project or worktree.
- `fs:user-data-write` to save, open, reveal, and delete screenshots and recordings.
- `clipboard:write` to copy console text and screenshot PNGs.

Flutter's machine protocols require bidirectional standard input and structured output. Daintree 0.29 exposes worker-readable output only for piped processes, whose stdin is closed, while writable stdin requires PTY mode and merges the streams. Until Flutter machine-mode compatibility with that PTY transport is proven, the plugin worker starts fixed Flutter commands directly with argument arrays and `shell: false`.

Screenshot copying uses Daintree's bounded, host-mediated image clipboard API. Opening or revealing private media uses Daintree's plugin-scoped system API. A custom save directory is an explicit user-selected setting; the trusted plugin worker writes one collision-safe file there and uses a fixed, shell-free macOS opener for that exact recorded path.

Flutter Tools does not include telemetry or a remote service. Flutter command output and captured media remain local to the Daintree plugin process, its user-data directory, and any save folder you explicitly configure.

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

- The React bundle owns presentation, selected-device views, bounded rendered output, filtering, PNG previews, recording controls, and user interaction.
- The Node worker owns worktree bindings, project discovery, SDK/ADB resolution, Flutter and recording processes, per-device sessions, and managed media files.
- Zod schemas validate renderer-to-worker requests, worker responses, and pushed console batches.
- Each panel has independent runtime state; each device has an independent run session and console buffer.

## Development

The current source setup expects a Daintree checkout at `../../Daintree` because the SDK, testing helpers, Vite preset, and CLI are referenced through local `file:` dependencies.

```text
Developer/
└── Electron/
    ├── Daintree/                    # Daintree v0.29.0 or compatible newer checkout
    └── DaintreePlugins/
        └── FlutterDaintree/         # this repository
```

Prepare Daintree first:

```sh
cd ../../Daintree
git checkout v0.29.0
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
- Screenshot availability remains device-dependent.
- Screen recording is Android-only. iOS, macOS, web, and other Flutter targets continue to support their existing non-recording controls.
- Android recordings have a hard three-minute limit, contain no audio, and use the device's current orientation. Some devices may impose additional `screenrecord` restrictions.
- Android Wear and unusual display configurations are not yet acceptance-tested.
- Media metadata belongs to the current plugin runtime. Files saved in private Flutter Tools storage remain there until explicitly deleted; files saved to a configured folder exist only in that folder.
- Removing media asks whether to keep the file and remove only its Media reference, or permanently delete the file as well.
- If a configured save folder is unavailable, Flutter Tools saves the capture in private storage and surfaces a warning.
- MP4 clipboard copying is intentionally unavailable; recordings provide **Open** and **Reveal** actions instead.

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
