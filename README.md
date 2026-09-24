# Update YouTube

Cross-platform JavaScript replacement for `update-youtube.sh`. It updates and caches yt-dlp, ensures ffmpeg is available, archives configured playlists/videos, fetches transcripts, creates transcript JSON, builds curated symlink names, collects transcript indexes, and runs optional post-steps.

## Run

Node.js 22 or newer is required to install/build the project. The runtime code itself remains compatible with Node.js 20 or newer.

```sh
npm install
npm test
node update-youtube.js --simulate
node update-youtube.js
```

The old `sim` argument remains supported. Use `--skip-update` to avoid the GitHub release check when a cached yt-dlp already exists.

On each normal run, the archiver fills missing `.info.json` metadata for archived MP4 files when an archive ID can be matched unambiguously. It then compares `archive.txt` with complete MP4/info pairs and refetches any archived video whose files are missing, bypassing the download archive only for that repair. It never overwrites an existing metadata file. Simulation mode only previews writes. Use `--skip-info-backfill` to skip both maintenance steps.

Without `--config`, the archiver looks for `config.json` in the current directory first, then beside `update-youtube.js`, then beside a standalone executable. The optional `customconfig.json` is loaded beside the selected `config.json`. Relative archive-content paths resolve from the current working directory, even when configuration falls back to the script directory.

```sh
node update-youtube.js --config /path/to/config.json
```

`archiveDirectory` is the root for every relative archive-content path: target directories, MP4s, archive files, metadata, subtitles, curated links, and `transcriptDestination`. It may be relative to the current working directory or absolute:

```json
{
  "applicationDirectory": ".update-youtube",
  "archiveDirectory": "/Volumes/VideoArchive"
}
```

`applicationDirectory` remains independent and controls the shared yt-dlp/Deno cache beside the selected config. Archive-specific state is stored in `.update-youtube/` beneath the current working directory. When the config directory and working directory are the same, both uses share that one directory. Post-step arguments may use `${archiveDir}` and `${configDir}` placeholders.

Download quality selection is configured by `quality.videoFormat`. It is passed directly to yt-dlp's `--format` option. The checked-in value preserves the existing MP4/M4A preference and 1080p ceiling; configs without this setting retain that same value as a backward-compatible default.

## Configuration

Copy `example.config.json` to the ignored `config.json` and replace its placeholder targets with your private archive configuration. If `customconfig.json` exists beside it, objects recursively override defaults and these arrays append to the defaults:

- `targets`
- `linkRules`
- `transcriptDirectories`
- `postSteps`

Copy `example.customconfig.json` to the ignored `customconfig.json` for private overrides, uploads, and extra archives.

Each target accepts `directory`, `url`, and `namingProfile`. Checked-in profiles preserve the two current layouts and offer alternative layouts containing the YouTube video ID:

- `title`
- `dated`
- `title-with-id`
- `dated-with-id`

Profiles live in `namingProfiles` and contain a yt-dlp `video` output template plus an optional distinct `subtitle` template. Set a target's `enable` field to `0` to skip it or `1` to run it. Optional target fields include `archive`, `subtitleLanguage`, `extraArgs`, and the legacy `enabled` boolean.

### Naming migration

Migration is declarative. Change a target to its desired profile and declare its previous profile:

```json
{
  "directory": "ExampleChannel/LiveStreams",
  "namingProfile": "dated-with-id",
  "migrateFrom": "dated"
}
```

On the next normal run, the archiver uses existing `.info.json` metadata and yt-dlp itself to calculate old and new names. If legacy files exist, it prints a prominent migration plan, changes nothing, stops before downloading, and asks you to rerun with:

```sh
update-youtube --apply
```

`migrateFrom` may also be an array of old profile names. Before moving anything, the complete plan is checked for missing videos, invalid metadata, unrecognized filenames, duplicate destinations, and existing destination files. The MP4, `.info.json`, and ID-associated SRT/JSON files move together. An applied plan is recorded under `cwd/.update-youtube/migrations/`, with each completed move saved immediately; after an interruption, the next run previews or resumes that same manifest instead of starting another migration. `--simulate --apply` remains non-destructive. Once no legacy files remain, normal archive runs continue even if `migrateFrom` stays configured.

Set an OS cookie browser to `null` to omit `--cookies-from-browser`. Cached application tools (yt-dlp and the Deno runtime required by yt-dlp) default to config-adjacent `.update-youtube/` on every OS; override `applicationDirectory` with either a relative or absolute path. Per-archive unavailable-video state, migration manifests, and temporary metadata use `cwd/.update-youtube/`.

Safari cookies are protected by macOS. When Safari is selected, grant Full Disk Access to the terminal application launching the archiver and restart that terminal. If macOS still denies the yt-dlp child process, add the archiver executable and cached `yt-dlp_macos` executable too. Selecting Chrome/Firefox or setting `cookies.macos` to `null` avoids Safari-cookie access.

On macOS, the updater also recursively clears Gatekeeper quarantine attributes from the cached yt-dlp and Deno directories with `xattr -cr`. This permits downloaded executables/libraries to launch, but it is separate from Full Disk Access and cannot grant access to Safari's protected cookies. Tool releases are downloaded into versioned staging directories, executed to verify their reported version, and only then selected through `current.json`; a failed update therefore leaves the previously installed version intact.

FFmpeg is intentionally supplied by the operating system rather than downloaded from third-party binary sites. The archiver requires both `ffmpeg` and `ffprobe` on PATH. When they are missing, it prints the appropriate Homebrew, winget, APT, DNF/YUM, Pacman, or APK command and offers to run it after an explicit confirmation.

## Windows symbolic links

The program tests symbolic-link permission before organizing files. If the test fails, enable **Settings > System > For developers > Developer Mode**, reopen the terminal, and retry. It never substitutes copies or hard links.

## Standalone builds

```sh
npm run build
```

Building requires Node.js 22 or newer. `npm run build` checks the active version first and exits with upgrade instructions when it is too old.

This first bundles the local modules, then builds standalone executables into `dist/` for:

- macOS Intel and Apple Silicon
- Windows x64 (`.exe`)
- Linux x64 and ARM64

Node.js is embedded in every standalone build. Running `update-youtube.js` with system Node.js 20+ remains available as an optional source/development path. yt-dlp and Deno are downloaded into the local application cache on every platform; FFmpeg comes from the OS package manager.

The completed `dist/` directory also contains `example.config.json`, `example.customconfig.json`, and this README. The temporary `.cjs` compiler bundle is removed automatically. Copy the examples to `config.json` and optionally `customconfig.json`; a standalone executable looks for `config.json` in the current directory first, then beside the executable.

The standalone executable expects `config.json` beside the working configuration location; pass `--config` when it lives elsewhere.
