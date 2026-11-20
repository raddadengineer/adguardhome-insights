# AdGuard Home Insights
**Multi-Level Query Flow (Sankey + Hierarchy Tree)**, **Traffic Map (Treemap)**, and **Activity & Latency Heatmaps (with Exemplars)** packaged as an installable, re-applyable overlay for existing **AdGuard Home** installations.

Your existing `AdGuardHome.yaml`, query logs, filter lists, and `stats.db` stay intact — `stats.db` additions in Insights are backwards- and forwards-compatible with stock AdGuard Home.

---

## 1. Quick Install on Existing Linux / Raspberry Pi / VM

Download the overlay installer and SHA-256 checksums from the latest release, verify the script checksum, and run `install`:

```sh
curl -fsSLO https://github.com/raddadengineer/adguardhome-insights/releases/latest/download/adguardhome-insights.sh
curl -fsSLO https://github.com/raddadengineer/adguardhome-insights/releases/latest/download/checksums.txt
sha256sum -c checksums.txt --ignore-missing
sudo sh ./adguardhome-insights.sh install
```

On macOS, verify checksums with:
```sh
grep 'adguardhome-insights.sh' checksums.txt | shasum -a 256 -c -
```

### What `install` does
1. Auto-detects your existing AdGuard Home directory (via `systemd` `ExecStart` or `/opt/AdGuardHome`; override with `--dir <path>`).
2. Downloads `AdGuardHome-insights_<os>_<arch>.tar.gz` and verifies its SHA-256 against `checksums.txt`.
3. Validates `--version` (`insights` marker) and runs `--check-config` against your existing `AdGuardHome.yaml` before touching the service.
4. Backs up your existing stock binary to `AdGuardHome.stock.bak` (without ever overwriting a stock backup with an Insights binary).
5. Atomically swaps the binary while preserving file ownership and `cap_net_bind_service` capabilities.
6. Restarts your service (`systemd`, OpenRC, or `./AdGuardHome -s`) and automatically rolls back to `AdGuardHome.stock.bak` on failure.
7. Saves source settings in `.insights-overlay.env` and links `/usr/local/bin/adguardhome-insights`.

Optional flags:
- `--dry-run` — preview what would change without modifying files or services.
- `--pin-updates` — add `--no-check-update` via a systemd drop-in (`/etc/systemd/system/AdGuardHome.service.d/10-insights-no-update.conf`) so stock auto-updates don't overwrite Insights unexpectedly.

### Re-installing After Upstream AdGuard Home Upgrades & Rolling Back

Insights binaries are built on the `development` update channel so AdGuard Home's in-UI upstream updater is intentionally disabled and won't nag or accidentally overwrite your Insights overlay with a stock build. To update Insights, use `adguardhome-insights reinstall` (or `docker compose ... pull && up -d`):

```sh
# Check overlay state (INSTALLED, OVERRIDDEN_BY_UPGRADE, MODIFIED, or NOT_INSTALLED)
adguardhome-insights status

# Re-apply / update Insights from GitHub using saved settings
sudo adguardhome-insights reinstall

# Revert to your backed-up stock AdGuard Home binary at any time (re-enabling stock UI updates)
sudo adguardhome-insights rollback
```

---

## 2. Existing Docker / Docker Compose Setup

Download the Compose override and verify its checksum:

```sh
curl -fsSLO https://github.com/raddadengineer/adguardhome-insights/releases/latest/download/docker-compose.insights.yml
curl -fsSLO https://github.com/raddadengineer/adguardhome-insights/releases/latest/download/checksums.txt
sha256sum -c checksums.txt --ignore-missing
docker compose -f compose.yml -f docker-compose.insights.yml pull
docker compose -f compose.yml -f docker-compose.insights.yml up -d
```

This pulls `ghcr.io/raddadengineer/adguardhome-insights/adguardhome:latest` while keeping your existing `conf` and `work` volumes intact.

> **Volume permissions note**: The Insights image runs unprivileged as `nobody:nogroup` (`65534:65534`). If an earlier container created root-owned files in `./conf` or `./work`, run `sudo chown -R 65534:65534 ./conf ./work` before starting (or temporarily set `user: "0:0"` in your local Compose override).

- **Revert to stock Docker AdGuard Home**: drop `-f docker-compose.insights.yml` and run `docker compose -f compose.yml up -d`.

---

## 3. Building From Source Locally

```sh
# Prepare pinned upstream source (UPSTREAM_REF) + overlay/ + patches/upstream.patch and build bundles
sh ./scripts/build-insights-bundle.sh --targets "linux/amd64 linux/arm64 linux/armv7"

# Or build via Docker Compose from local source
docker compose -f /path/to/compose.yml -f packaging/docker-compose.build.yml up -d --build
```

---

## 4. Tracking New Upstream AdGuard Home Releases

This repository stores:
- [UPSTREAM_REF](UPSTREAM_REF) — pinned `AdguardTeam/AdGuardHome` commit/tag.
- `overlay/` — standalone new files for Insights observability and drill-down.
- [patches/upstream.patch](patches/upstream.patch) — minimal patch wiring Insights into upstream files.

To target a newer upstream AdGuard Home commit/tag:
1. Run `sh ./scripts/prepare-src.sh --clean` (or update `UPSTREAM_COMMIT` in `UPSTREAM_REF` and resolve any conflict in `patches/upstream.patch`).
2. Tag and push `v0.x.y` to trigger CI verification, multi-arch release bundles, and GHCR image builds.

Licensed under **GPL-3.0** (see [LICENSE.txt](LICENSE.txt)), matching upstream AdGuard Home.
