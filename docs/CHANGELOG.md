# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.5] - 2026-04-15

### Changed
- Upgrade `vigo` dependency from `v0.6.0` to `v0.6.5` to fix `flags` API compatibility for remote installation.
- Refactor `v-i18n` CLI: simplify commands to `scan` and `add` only.
  - `scan`: auto-sort, auto-cleanup unused/empty keys, report missing keys, output copy-paste ready `add -json` command.
  - `add`: accept JSON via pipe, `-json` flag or positional argument.
- Implement custom JSON marshal in `v-i18n` to guarantee deterministic language and key ordering (`defaultLanguage` first).
- Update `docs/agents.md` with new `v-i18n` usage examples and `go install` instructions.

### Fixed
- Fix `v-i18n` remote installation failure caused by incompatible `vigo` version resolution.

## [0.7.4] - 2026-04-15

### Changed
- Bump `v-i18n` CLI version string and `package.json` to align with project versioning.

## [0.7.3] - 2026-04-15

### Fixed
- Fix `v-i18n scan` output to use `v-i18n add -json` for copy-paste compatibility.
- Sync `ui/langs.json` with latest scan results.

## [0.7.2] - 2026-04-15

### Changed
- Update `docs/agents.md` `v-i18n` usage to use `-json` flag.
- Align `v-i18n` CLI version with root `package.json`.

## [0.7.1] - 2026-04-15

### Changed
- Remove standalone `v-i18n` versioning; use root `package.json` version as single source of truth.
- Delete obsolete `v-i18n/v0.2.0` tag, create global `v0.7.1` tag.

---

## Release Workflow

Follow these steps when publishing a new version:

### 1. Update Version Numbers
- Update `version` in `package.json`.
- Update `version` variable in `cli/v-i18n/main.go` to match.

### 2. Update Documentation
- Update `cli/v-i18n/README.md` if command behavior or usage changes.
- Update `docs/agents.md` if `v-i18n` usage examples need updating.
- Add a new section to `docs/CHANGELOG.md` describing the release.

### 3. Build and Test Locally
```bash
cd cli/v-i18n
go build -o v-i18n .
go install .
v-i18n -h
```

### 4. Commit Changes on `dev`
```bash
git checkout dev
git add package.json cli/v-i18n/main.go docs/CHANGELOG.md [other changed files]
git commit -m "chore(release): bump version to vX.Y.Z"
```

### 5. Merge `dev` into `main`
```bash
git checkout main
git merge dev
git push origin main dev
```

### 6. Create and Push Tag
```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

### 7. Verify Remote Installation
```bash
go clean -modcache
GOPROXY=https://goproxy.cn,direct GOSUMDB=off \
  go install github.com/veypi/vhtml/cli/v-i18n@vX.Y.Z
v-i18n -h
```

### 8. Switch Back to `dev`
```bash
git checkout dev
```

### Notes
- Go module proxy caches versions permanently. If a tag is broken, **do not force-push the same tag**. Always increment to a new version number (e.g., `v0.7.3` → `v0.7.4`).
- Keep `v-i18n` CLI version synchronized with `package.json` at all times.
