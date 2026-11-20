#!/bin/sh

# Installer, status inspector, upgrade-reinstaller, and rollback manager for the
# AdGuard Home Insights overlay binary.

set -e -f -u

SCRIPT_NAME='adguardhome-insights.sh'
DEFAULT_GITHUB_REPO='raddadengineer/adguardhome-insights'

log() {
	printf '[insights] %s\n' "$1"
}

warn() {
	printf '[insights] warning: %s\n' "$1" 1>&2
}

die() {
	printf '[insights] error: %s\n' "$1" 1>&2
	exit 1
}

usage() {
	cat <<'EOF'
Usage: adguardhome-insights.sh <subcommand> [options]

Subcommands:
  install      Overlay an Insights-enabled AdGuard Home binary onto an
               existing installation while backing up the stock binary.
  reinstall    Re-apply the remembered Insights source after an upstream
               AdGuard Home upgrade replaced the binary (accepts overrides).
  status       Report installation state, versions, checksums, and service health.
  rollback     Restore AdGuardHome.stock.bak, restart the service, and clean up.
  uninstall    Alias for rollback.
  help         Print this help message and exit.

Common Options:
  --dir <path>           Existing AdGuard Home directory (auto-detected if omitted)
  --config <path>        Path to AdGuardHome.yaml (default: <dir>/AdGuardHome.yaml)
  --service <name>       Service name (default: AdGuardHome)
  --no-service           Skip stopping/restarting the system service
  --cli-path <path>      Helper install path (default: /usr/local/bin/adguardhome-insights)
  --no-cli               Do not install/update the helper CLI symlink/copy
  --probe-url <url>      HTTP base URL to probe /control/stats/flow after start
  --allow-unmarked       Allow binaries whose --version lacks "insights"
  --pin-updates          Write systemd drop-in adding --no-check-update (Linux only)
  --dry-run              Show planned actions without modifying files or services
  --strict               For status: exit non-zero unless state is INSTALLED
  --remove-cli           For rollback/uninstall: also remove the installed CLI helper
  -h, --help             Print this help message

Source Options (for install / reinstall; pick one):
  --binary <path>        Path to a prebuilt Insights AdGuardHome binary
  --bundle <path>        Path to AdGuardHome-insights_<os>_<arch>.tar.gz
  --checksums <path>     Path to checksums.txt to verify --bundle or --binary
  --sha256 <hex>         Expected SHA-256 hex digest for the source archive/binary
  --url <base-url>       Base URL serving AdGuardHome-insights_<os>_<arch>.tar.gz
                         and checksums.txt
  --repo <owner/repo>    GitHub repository hosting release assets & checksums.txt
                         (defaults to raddadengineer/adguardhome-insights on install)
  --tag <tag|latest>     GitHub release tag when using --repo (default: latest)
  --source-dir <path>    Local AdGuardHome git checkout to build with
                         scripts/build-insights-bundle.sh --targets host
EOF
}

if [ "$#" -lt 1 ]; then
	usage 1>&2
	exit 2
fi

subcmd="$1"
case "$subcmd" in
-h|--help|help)
	usage
	exit 0
	;;
install|reinstall|status|rollback|uninstall)
	shift
	;;
*)
	die "unknown subcommand '$subcmd' (run with --help)"
	;;
esac

if [ "$subcmd" = 'uninstall' ]; then
	subcmd='rollback'
fi

# User/CLI configuration defaults and explicit-override tracking flags.
opt_dir=''
opt_config=''
opt_service='AdGuardHome'
set_service='0'
opt_no_service='0'
opt_binary=''
opt_bundle=''
opt_checksums=''
opt_sha256=''
opt_url=''
opt_repo=''
opt_tag='latest'
set_tag='0'
opt_source_dir=''
opt_cli_path='/usr/local/bin/adguardhome-insights'
opt_no_cli='0'
set_no_cli='0'
opt_pin_updates='0'
set_pin_updates='0'
opt_probe_url=''
opt_allow_unmarked='0'
set_allow_unmarked='0'
opt_dry_run='0'
opt_strict='0'
opt_remove_cli='0'
cli_source_set='0'

need_arg() {
	if [ "$#" -lt 2 ]; then
		die "option $1 requires an argument"
	fi
}

while [ "$#" -gt 0 ]; do
	case "$1" in
	--dir)
		need_arg "$@"
		opt_dir="$2"
		shift 2
		;;
	--config)
		need_arg "$@"
		opt_config="$2"
		shift 2
		;;
	--service)
		need_arg "$@"
		opt_service="$2"
		set_service='1'
		shift 2
		;;
	--no-service)
		opt_no_service='1'
		shift
		;;
	--binary)
		need_arg "$@"
		opt_binary="$2"
		cli_source_set='1'
		shift 2
		;;
	--bundle)
		need_arg "$@"
		opt_bundle="$2"
		cli_source_set='1'
		shift 2
		;;
	--checksums)
		need_arg "$@"
		opt_checksums="$2"
		shift 2
		;;
	--sha256)
		need_arg "$@"
		opt_sha256="$2"
		shift 2
		;;
	--url)
		need_arg "$@"
		opt_url="$2"
		cli_source_set='1'
		shift 2
		;;
	--repo)
		need_arg "$@"
		opt_repo="$2"
		cli_source_set='1'
		shift 2
		;;
	--tag)
		need_arg "$@"
		opt_tag="$2"
		set_tag='1'
		shift 2
		;;
	--source-dir)
		need_arg "$@"
		opt_source_dir="$2"
		cli_source_set='1'
		shift 2
		;;
	--cli-path)
		need_arg "$@"
		opt_cli_path="$2"
		shift 2
		;;
	--no-cli)
		opt_no_cli='1'
		set_no_cli='1'
		shift
		;;
	--pin-updates)
		opt_pin_updates='1'
		set_pin_updates='1'
		shift
		;;
	--probe-url)
		need_arg "$@"
		opt_probe_url="$2"
		shift 2
		;;
	--allow-unmarked)
		opt_allow_unmarked='1'
		set_allow_unmarked='1'
		shift
		;;
	--dry-run)
		opt_dry_run='1'
		shift
		;;
	--strict)
		opt_strict='1'
		shift
		;;
	--remove-cli)
		opt_remove_cli='1'
		shift
		;;
	-h|--help)
		usage
		exit 0
		;;
	*)
		die "unknown option: $1"
		;;
	esac
done

abs_path() {
	p="$1"
	if [ -z "$p" ]; then
		return 0
	fi
	if [ -d "$p" ]; then
		(cd "$p" && pwd -P)
		return 0
	fi
	parent="$(dirname "$p")"
	base="$(basename "$p")"
	if [ -d "$parent" ]; then
		printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$base"
	else
		printf '%s\n' "$p"
	fi
}

sha256_file() {
	target="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$target" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$target" | awk '{print $1}'
	else
		die 'neither sha256sum nor shasum found'
	fi
}

lookup_checksum() {
	sum_file="$1"
	asset_name="$2"
	awk -v name="$asset_name" '
		/^[0-9a-fA-F]{64}[[:space:]]/ {
			f = $2
			sub(/^\*/, "", f)
			sub(/^.*\//, "", f)
			if (f == name) {
				print tolower($1)
				exit
			}
		}
	' "$sum_file"
}

verify_sha256() {
	file_path="$1"
	expected="$2"
	label="$3"
	expected_lc="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
	actual_lc="$(sha256_file "$file_path" | tr '[:upper:]' '[:lower:]')"
	if [ "$actual_lc" != "$expected_lc" ]; then
		die "SHA-256 mismatch for ${label}: expected ${expected_lc}, got ${actual_lc}"
	fi
	log "verified SHA-256 (${label}): ${actual_lc}"
}

version_has_insights() {
	ver_str="$1"
	if [ -z "$ver_str" ]; then
		return 1
	fi
	printf '%s' "$ver_str" | tr '[:upper:]' '[:lower:]' | grep -q 'insights'
}

detect_platform() {
	raw_os="$(uname -s)"
	case "$raw_os" in
	Linux)   plat_os='linux' ;;
	Darwin)  plat_os='darwin' ;;
	FreeBSD) plat_os='freebsd' ;;
	OpenBSD) plat_os='openbsd' ;;
	*)       die "unsupported OS: $raw_os" ;;
	esac

	raw_arch="$(uname -m)"
	case "$raw_arch" in
	x86_64|x86-64|amd64) plat_arch='amd64' ;;
	i386|i486|i686|x86)  plat_arch='386' ;;
	aarch64|arm64)       plat_arch='arm64' ;;
	armv6l)              plat_arch='armv6' ;;
	armv7l|armv8l)       plat_arch='armv7' ;;
	*)                   die "unsupported CPU architecture: $raw_arch" ;;
	esac
}

download_file() {
	src_url="$1"
	dst_file="$2"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$src_url" -o "$dst_file"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$dst_file" "$src_url"
	else
		die 'either curl or wget is required for remote downloads'
	fi
}

http_probe_ok() {
	probe_url="$1"
	if command -v curl >/dev/null 2>&1; then
		code="$(curl -sS -o /dev/null -w '%{http_code}' "$probe_url" || true)"
		[ "$code" = '200' ]
		return $?
	elif command -v wget >/dev/null 2>&1; then
		wget -qO /dev/null "$probe_url"
		return $?
	fi
	return 1
}

detect_install_dir() {
	if [ -n "$opt_dir" ]; then
		abs_path "$opt_dir"
		return 0
	fi
	if command -v systemctl >/dev/null 2>&1; then
		exec_line="$(systemctl show -p ExecStart --value "$opt_service" 2>/dev/null || true)"
		if [ -n "$exec_line" ]; then
			bin_cand="$(printf '%s\n' "$exec_line" | sed -n 's/.*path=\([^ ;]*\).*/\1/p')"
			if [ -z "$bin_cand" ]; then
				bin_cand="$(printf '%s\n' "$exec_line" | awk '{print $1}')"
			fi
			if [ -n "$bin_cand" ] && [ -e "$bin_cand" ]; then
				dirname "$(abs_path "$bin_cand")"
				return 0
			fi
		fi
	fi
	for candidate_dir in /opt/AdGuardHome /usr/local/AdGuardHome /opt/adguardhome; do
		if [ -e "${candidate_dir}/AdGuardHome" ]; then
			printf '%s\n' "$candidate_dir"
			return 0
		fi
	done
	printf '%s\n' '/opt/AdGuardHome'
}

file_owner_group() {
	target="$1"
	if stat -c '%u:%g' "$target" >/dev/null 2>&1; then
		stat -c '%u:%g' "$target"
	elif stat -f '%u:%g' "$target" >/dev/null 2>&1; then
		stat -f '%u:%g' "$target"
	fi
}

file_caps() {
	target="$1"
	if command -v getcap >/dev/null 2>&1; then
		raw_cap="$(getcap "$target" 2>/dev/null || true)"
		if [ -n "$raw_cap" ]; then
			printf '%s\n' "$raw_cap" | sed -n 's/^.* [= ]*//p'
		fi
	fi
}

apply_owner_caps() {
	target="$1"
	owner="$2"
	caps="$3"
	chmod 0755 "$target"
	if [ -n "$owner" ] && [ "$(id -u)" -eq 0 ]; then
		chown "$owner" "$target" || warn "failed to chown $owner on $target"
	fi
	if [ -n "$caps" ] && command -v setcap >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
		setcap "$caps" "$target" 2>/dev/null \
			|| setcap 'cap_net_bind_service=+eip' "$target" 2>/dev/null \
			|| warn "failed to apply capabilities ($caps) to $target"
	fi
}

detect_service_mgr() {
	if [ "$opt_no_service" -eq '1' ]; then
		printf '%s\n' 'none'
		return 0
	fi
	if command -v systemctl >/dev/null 2>&1 \
		&& systemctl cat "${opt_service}.service" >/dev/null 2>&1; then
		printf '%s\n' 'systemd'
		return 0
	fi
	if command -v rc-service >/dev/null 2>&1 \
		&& rc-service -e "$opt_service" >/dev/null 2>&1; then
		printf '%s\n' 'openrc'
		return 0
	fi
	if [ -e "${install_dir}/AdGuardHome" ]; then
		printf '%s\n' 'binary'
		return 0
	fi
	printf '%s\n' 'none'
}

service_is_active() {
	mgr="$1"
	case "$mgr" in
	systemd)
		systemctl is-active --quiet "$opt_service"
		;;
	openrc)
		rc-service "$opt_service" status >/dev/null 2>&1
		;;
	binary)
		(cd "$install_dir" && ./AdGuardHome -s status >/dev/null 2>&1)
		;;
	*)
		return 1
		;;
	esac
}

service_stop() {
	mgr="$1"
	case "$mgr" in
	systemd)
		systemctl stop "$opt_service"
		;;
	openrc)
		rc-service "$opt_service" stop
		;;
	binary)
		(cd "$install_dir" && ./AdGuardHome -s stop)
		;;
	*)
		return 0
		;;
	esac
}

service_start() {
	mgr="$1"
	case "$mgr" in
	systemd)
		systemctl start "$opt_service"
		;;
	openrc)
		rc-service "$opt_service" start
		;;
	binary)
		(cd "$install_dir" && ./AdGuardHome -s start)
		;;
	*)
		return 0
		;;
	esac
}

systemd_unit_execstart() {
	frag="$(systemctl show -p FragmentPath --value "$opt_service" 2>/dev/null || true)"
	if [ -n "$frag" ] && [ -f "$frag" ]; then
		sed -n 's/^ExecStart=//p' "$frag" | head -n 1
		return 0
	fi
	printf '%s/AdGuardHome -s run\n' "$install_dir"
}

apply_systemd_pin() {
	dropin_dir="/etc/systemd/system/${opt_service}.service.d"
	dropin_file="${dropin_dir}/10-insights-no-update.conf"
	orig_exec="$(systemd_unit_execstart)"
	case "$orig_exec" in
	*--no-check-update*)
		new_exec="$orig_exec"
		;;
	*)
		new_exec="${orig_exec} --no-check-update"
		;;
	esac
	mkdir -p "$dropin_dir"
	cat > "$dropin_file" <<EOF
[Service]
ExecStart=
ExecStart=${new_exec}
EOF
	chmod 0644 "$dropin_file"
	systemctl daemon-reload
	log "pinned upstream auto-update checks via ${dropin_file}"
}

remove_systemd_pin() {
	dropin_dir="/etc/systemd/system/${opt_service}.service.d"
	dropin_file="${dropin_dir}/10-insights-no-update.conf"
	if [ -f "$dropin_file" ]; then
		rm -f "$dropin_file"
		rmdir "$dropin_dir" 2>/dev/null || true
		if command -v systemctl >/dev/null 2>&1; then
			systemctl daemon-reload || true
		fi
		log "removed systemd drop-in ${dropin_file}"
	fi
}

# Manifest variables (populated cleanly via line-by-line read without eval).
m_state=''
m_insights_version=''
m_insights_sha256=''
m_stock_version=''
m_stock_sha256=''
m_source_kind=''
m_source_value=''
m_source_tag=''
m_config_path=''
m_service_name=''
m_pin_updates=''
m_allow_unmarked=''
m_cli_path=''
m_installed_at=''

load_manifest() {
	mf="$1"
	[ -f "$mf" ] || return 1
	while IFS='=' read -r k v; do
		case "$k" in
		INSIGHTS_STATE)   m_state="$v" ;;
		INSIGHTS_VERSION) m_insights_version="$v" ;;
		INSIGHTS_SHA256)  m_insights_sha256="$v" ;;
		STOCK_VERSION)    m_stock_version="$v" ;;
		STOCK_SHA256)     m_stock_sha256="$v" ;;
		SOURCE_KIND)      m_source_kind="$v" ;;
		SOURCE_VALUE)     m_source_value="$v" ;;
		SOURCE_TAG)       m_source_tag="$v" ;;
		CONFIG_PATH)      m_config_path="$v" ;;
		SERVICE_NAME)     m_service_name="$v" ;;
		PIN_UPDATES)      m_pin_updates="$v" ;;
		ALLOW_UNMARKED)   m_allow_unmarked="$v" ;;
		CLI_PATH)         m_cli_path="$v" ;;
		INSTALLED_AT)     m_installed_at="$v" ;;
		*)                ;;
		esac
	done < "$mf"
	return 0
}

write_manifest() {
	mf="$1"
	tmp_mf="${install_dir}/.insights-overlay.env.tmp"
	cat > "$tmp_mf" <<EOF
INSIGHTS_STATE=installed
INSIGHTS_VERSION=${new_insights_ver}
INSIGHTS_SHA256=${new_insights_sha}
STOCK_VERSION=${new_stock_ver}
STOCK_SHA256=${new_stock_sha}
SOURCE_KIND=${source_kind}
SOURCE_VALUE=${source_value}
SOURCE_TAG=${opt_tag}
CONFIG_PATH=${config_path}
SERVICE_NAME=${opt_service}
PIN_UPDATES=${opt_pin_updates}
ALLOW_UNMARKED=${opt_allow_unmarked}
CLI_PATH=${saved_cli_path}
INSTALLED_AT=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
EOF
	chmod 0644 "$tmp_mf"
	mv -f "$tmp_mf" "$mf"
}

install_dir="$(detect_install_dir)"
target_bin="${install_dir}/AdGuardHome"
backup_bin="${install_dir}/AdGuardHome.stock.bak"
manifest_file="${install_dir}/.insights-overlay.env"

if [ -z "$opt_config" ]; then
	config_path="${install_dir}/AdGuardHome.yaml"
else
	config_path="$(abs_path "$opt_config")"
fi

if [ "$subcmd" = 'status' ]; then
	[ -e "$target_bin" ] || die "AdGuard Home binary not found at ${target_bin}"

	cur_ver="$("$target_bin" --version 2>/dev/null | head -n 1 || true)"
	cur_sha="$(sha256_file "$target_bin")"
	has_manifest='0'
	if load_manifest "$manifest_file"; then
		has_manifest='1'
	fi

	state_label='NOT_INSTALLED'
	if [ "$has_manifest" -eq '1' ]; then
		if ! version_has_insights "$cur_ver"; then
			state_label='OVERRIDDEN_BY_UPGRADE'
		elif [ -n "$m_insights_sha256" ] && [ "$cur_sha" = "$m_insights_sha256" ]; then
			state_label='INSTALLED'
		else
			state_label='MODIFIED'
		fi
	elif version_has_insights "$cur_ver"; then
		state_label='INSTALLED_UNTRACKED'
	fi

	svc_mgr="$(detect_service_mgr)"
	svc_state='skipped'
	if [ "$svc_mgr" != 'none' ]; then
		if service_is_active "$svc_mgr"; then
			svc_state="active (${svc_mgr})"
		else
			svc_state="inactive (${svc_mgr})"
		fi
	fi

	printf 'State:         %s\n' "$state_label"
	printf 'Directory:     %s\n' "$install_dir"
	printf 'Binary:        %s\n' "$target_bin"
	printf 'Version:       %s\n' "${cur_ver:-unknown}"
	printf 'SHA-256:       %s\n' "$cur_sha"
	if [ -f "$backup_bin" ]; then
		bak_ver="$("$backup_bin" --version 2>/dev/null | head -n 1 || true)"
		printf 'Stock backup:  %s (%s)\n' "$backup_bin" "${bak_ver:-unknown}"
	else
		printf 'Stock backup:  none\n'
	fi
	if [ "$has_manifest" -eq '1' ] && [ -n "$m_source_kind" ]; then
		printf 'Source:        %s:%s\n' "$m_source_kind" "$m_source_value"
	fi
	printf 'Service:       %s\n' "$svc_state"

	if [ -n "$opt_probe_url" ]; then
		probe_target="${opt_probe_url%/}/control/stats/flow?window=1h"
		if http_probe_ok "$probe_target"; then
			printf 'HTTP probe:    OK (%s)\n' "$probe_target"
		else
			printf 'HTTP probe:    FAILED (%s)\n' "$probe_target"
			if [ "$opt_strict" -eq '1' ]; then
				exit 1
			fi
		fi
	fi

	if [ "$opt_strict" -eq '1' ] && [ "$state_label" != 'INSTALLED' ]; then
		exit 1
	fi
	exit 0
fi

[ -e "$target_bin" ] || die "existing AdGuard Home binary not found at ${target_bin}"

if [ "$subcmd" = 'rollback' ]; then
	[ -f "$backup_bin" ] || die "stock backup not found at ${backup_bin}"
	load_manifest "$manifest_file" || true

	bak_ver="$("$backup_bin" --version 2>/dev/null | head -n 1 || true)"
	[ -n "$bak_ver" ] || die "stock backup failed --version check: ${backup_bin}"
	if [ -f "$config_path" ]; then
		"$backup_bin" --check-config -c "$config_path" >/dev/null 2>&1 \
			|| die "stock backup failed --check-config against ${config_path}"
	fi

	svc_mgr="$(detect_service_mgr)"
	if [ "$opt_dry_run" -eq '1' ]; then
		log "[dry-run] would restore ${backup_bin} -> ${target_bin} (${bak_ver})"
		log "[dry-run] would remove ${manifest_file} and restart service (${svc_mgr})"
		exit 0
	fi

	orig_owner="$(file_owner_group "$target_bin")"
	orig_caps="$(file_caps "$target_bin")"

	staged_bak="${install_dir}/.AdGuardHome.rollback.tmp"
	cp "$backup_bin" "$staged_bak"
	apply_owner_caps "$staged_bak" "$orig_owner" "$orig_caps"

	was_active='0'
	if [ "$svc_mgr" != 'none' ] && service_is_active "$svc_mgr"; then
		was_active='1'
		service_stop "$svc_mgr"
	fi

	mv -f "$staged_bak" "$target_bin"
	remove_systemd_pin
	rm -f "$manifest_file" "${install_dir}/adguardhome-insights.sh"

	if [ "$opt_remove_cli" -eq '1' ]; then
		rm_cli="${m_cli_path:-$opt_cli_path}"
		if [ -n "$rm_cli" ] && { [ -e "$rm_cli" ] || [ -L "$rm_cli" ]; }; then
			rm -f "$rm_cli"
			log "removed CLI helper ${rm_cli}"
		fi
	fi

	if [ "$was_active" -eq '1' ]; then
		service_start "$svc_mgr"
	fi

	log "rolled back to stock binary: ${bak_ver}"
	exit 0
fi

# From here on, subcommand is either 'install' or 'reinstall'.
if [ "$subcmd" = 'reinstall' ]; then
	if ! load_manifest "$manifest_file"; then
		if [ "$cli_source_set" -eq '0' ]; then
			die "no saved overlay manifest at ${manifest_file}; run 'install' or pass source options"
		fi
	fi

	if [ "$set_service" -eq '0' ] && [ -n "$m_service_name" ]; then
		opt_service="$m_service_name"
	fi
	if [ -z "$opt_config" ] && [ -n "$m_config_path" ]; then
		config_path="$m_config_path"
	fi
	if [ "$set_pin_updates" -eq '0' ] && [ -n "$m_pin_updates" ]; then
		opt_pin_updates="$m_pin_updates"
	fi
	if [ "$set_allow_unmarked" -eq '0' ] && [ -n "$m_allow_unmarked" ]; then
		opt_allow_unmarked="$m_allow_unmarked"
	fi
	if [ "$set_no_cli" -eq '0' ]; then
		if [ -n "$m_cli_path" ]; then
			opt_cli_path="$m_cli_path"
		elif [ -n "$m_state" ] && [ -z "$m_cli_path" ]; then
			opt_no_cli='1'
		fi
	fi
	if [ "$cli_source_set" -eq '0' ]; then
		case "$m_source_kind" in
		binary)     opt_binary="$m_source_value" ;;
		bundle)     opt_bundle="$m_source_value" ;;
		url)        opt_url="$m_source_value" ;;
		repo)       opt_repo="$m_source_value" ;;
		source-dir) opt_source_dir="$m_source_value" ;;
		*)          die "saved manifest lacks a valid source; pass --binary, --bundle, --url, --repo, or --source-dir" ;;
		esac
		if [ "$set_tag" -eq '0' ] && [ -n "$m_source_tag" ]; then
			opt_tag="$m_source_tag"
		fi
	fi
fi

# Validate exactly one source was chosen.
src_count=0
source_kind=''
source_value=''
if [ -n "$opt_binary" ]; then
	src_count=$((src_count + 1))
	source_kind='binary'
	source_value="$(abs_path "$opt_binary")"
fi
if [ -n "$opt_bundle" ]; then
	src_count=$((src_count + 1))
	source_kind='bundle'
	source_value="$(abs_path "$opt_bundle")"
fi
if [ -n "$opt_url" ]; then
	src_count=$((src_count + 1))
	source_kind='url'
	source_value="${opt_url%/}"
fi
if [ -n "$opt_repo" ]; then
	src_count=$((src_count + 1))
	source_kind='repo'
	source_value="$opt_repo"
fi
if [ -n "$opt_source_dir" ]; then
	src_count=$((src_count + 1))
	source_kind='source-dir'
	source_value="$(abs_path "$opt_source_dir")"
fi

if [ "$src_count" -eq '0' ] && [ "$subcmd" = 'install' ]; then
	src_count=1
	source_kind='repo'
	source_value="$DEFAULT_GITHUB_REPO"
	log "using default GitHub Releases source: ${DEFAULT_GITHUB_REPO} (tag: ${opt_tag})"
fi

if [ "$src_count" -ne '1' ]; then
	die 'specify at most one source (--binary, --bundle, --url, --repo, or --source-dir)'
fi

if [ -n "$opt_checksums" ]; then
	opt_checksums="$(abs_path "$opt_checksums")"
fi

tmp_root=''
staged_bin="${install_dir}/.AdGuardHome.insights.new"
cleanup() {
	rm -f "$staged_bin" 2>/dev/null || true
	if [ -n "$tmp_root" ] && [ -d "$tmp_root" ]; then
		rm -rf "${tmp_root:?}"
	fi
}
trap cleanup EXIT INT TERM

if [ "$opt_dry_run" -eq '1' ]; then
	log "[dry-run] subcommand=${subcmd} dir=${install_dir} config=${config_path}"
	log "[dry-run] source=${source_kind}:${source_value} service=${opt_service} no_service=${opt_no_service}"
	log "[dry-run] stock backup rule: preserve AdGuardHome.stock.bak if active binary already has insights"
	exit 0
fi

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/agh-insights-install.XXXXXX")"
candidate_bin="${tmp_root}/AdGuardHome"

prepare_bundle_archive() {
	archive_path="$1"
	sum_hint="$2"

	if [ -n "$opt_sha256" ]; then
		verify_sha256 "$archive_path" "$opt_sha256" "$(basename "$archive_path")"
	elif [ -n "$sum_hint" ] && [ -f "$sum_hint" ]; then
		want_sum="$(lookup_checksum "$sum_hint" "$(basename "$archive_path")")"
		if [ -n "$want_sum" ]; then
			verify_sha256 "$archive_path" "$want_sum" "$(basename "$archive_path")"
		elif [ "$source_kind" = 'url' ] || [ "$source_kind" = 'repo' ]; then
			die "no SHA-256 entry for $(basename "$archive_path") in ${sum_hint}"
		fi
	elif [ "$source_kind" = 'url' ] || [ "$source_kind" = 'repo' ]; then
		die 'remote installs require --sha256 or a checksums.txt file'
	fi

	extract_dir="${tmp_root}/unpacked"
	mkdir -p "$extract_dir"
	tar -C "$extract_dir" -xzf "$archive_path"
	[ -f "${extract_dir}/AdGuardHome" ] || die "archive ${archive_path} missing AdGuardHome binary"
	cp "${extract_dir}/AdGuardHome" "$candidate_bin"
}

case "$source_kind" in
binary)
	[ -f "$source_value" ] || die "binary not found: ${source_value}"
	if [ -n "$opt_sha256" ]; then
		verify_sha256 "$source_value" "$opt_sha256" "$(basename "$source_value")"
	elif [ -n "$opt_checksums" ] && [ -f "$opt_checksums" ]; then
		want_sum="$(lookup_checksum "$opt_checksums" "$(basename "$source_value")")"
		[ -n "$want_sum" ] || die "no entry for $(basename "$source_value") in ${opt_checksums}"
		verify_sha256 "$source_value" "$want_sum" "$(basename "$source_value")"
	fi
	cp "$source_value" "$candidate_bin"
	;;
bundle)
	[ -f "$source_value" ] || die "bundle not found: ${source_value}"
	sum_file="$opt_checksums"
	if [ -z "$sum_file" ]; then
		sibling="$(dirname "$source_value")/checksums.txt"
		if [ -f "$sibling" ]; then
			sum_file="$sibling"
		fi
	fi
	prepare_bundle_archive "$source_value" "$sum_file"
	;;
url|repo)
	detect_platform
	asset_name="AdGuardHome-insights_${plat_os}_${plat_arch}.tar.gz"
	if [ "$source_kind" = 'repo' ]; then
		if [ "$opt_tag" = 'latest' ]; then
			base_url="https://github.com/${source_value}/releases/latest/download"
		else
			base_url="https://github.com/${source_value}/releases/download/${opt_tag}"
		fi
	else
		base_url="$source_value"
	fi
	dl_archive="${tmp_root}/${asset_name}"
	dl_sums="${tmp_root}/checksums.txt"
	log "downloading ${base_url}/${asset_name}"
	download_file "${base_url}/${asset_name}" "$dl_archive"
	if [ -z "$opt_sha256" ]; then
		download_file "${base_url}/checksums.txt" "$dl_sums"
	fi
	prepare_bundle_archive "$dl_archive" "$dl_sums"
	;;
source-dir)
	[ -d "$source_value" ] || die "source dir not found: ${source_value}"
	[ -f "${source_value}/scripts/build-insights-bundle.sh" ] \
		|| die "missing scripts/build-insights-bundle.sh in ${source_value}"
	detect_platform
	build_out="${tmp_root}/src-dist"
	log "building Insights bundle from ${source_value} (target=${plat_os}/${plat_arch})"
	(
		cd "$source_value"
		sh ./scripts/build-insights-bundle.sh \
			--targets "${plat_os}/${plat_arch}" \
			--out-dir "$build_out"
	)
	prepare_bundle_archive "${build_out}/AdGuardHome-insights_${plat_os}_${plat_arch}.tar.gz" "${build_out}/checksums.txt"
	;;
esac

chmod 0755 "$candidate_bin"
cand_ver="$("$candidate_bin" --version 2>/dev/null | head -n 1 || true)"
[ -n "$cand_ver" ] || die 'candidate binary failed to execute --version'
if [ "$opt_allow_unmarked" -eq '0' ] && ! version_has_insights "$cand_ver"; then
	die "candidate version '$cand_ver' lacks 'insights' marker (pass --allow-unmarked to override)"
fi
if [ -f "$config_path" ]; then
	log "validating candidate against ${config_path}"
	"$candidate_bin" --check-config -c "$config_path" >/dev/null 2>&1 \
		|| die "candidate binary rejected configuration ${config_path}"
fi
cand_sha="$(sha256_file "$candidate_bin")"

# Preserve stock binary backup; refresh it whenever active binary is stock
# (e.g., first install OR after an upstream upgrade replaced Insights).
cur_ver="$("$target_bin" --version 2>/dev/null | head -n 1 || true)"
cur_sha="$(sha256_file "$target_bin")"
if ! version_has_insights "$cur_ver"; then
	log "backing up stock binary (${cur_ver:-unknown}) -> ${backup_bin}"
	cp "$target_bin" "$backup_bin"
	chmod 0755 "$backup_bin"
	new_stock_ver="$cur_ver"
	new_stock_sha="$cur_sha"
else
	if [ -f "$backup_bin" ]; then
		new_stock_ver="$("$backup_bin" --version 2>/dev/null | head -n 1 || true)"
		new_stock_sha="$(sha256_file "$backup_bin")"
	else
		new_stock_ver="${m_stock_version:-unknown}"
		new_stock_sha="${m_stock_sha256:-}"
	fi
fi
new_insights_ver="$cand_ver"
new_insights_sha="$cand_sha"

orig_owner="$(file_owner_group "$target_bin")"
orig_caps="$(file_caps "$target_bin")"

cp "$candidate_bin" "$staged_bin"
apply_owner_caps "$staged_bin" "$orig_owner" "$orig_caps"

svc_mgr="$(detect_service_mgr)"
was_active='0'
if [ "$svc_mgr" != 'none' ]; then
	if service_is_active "$svc_mgr"; then
		was_active='1'
		log "stopping ${opt_service} (${svc_mgr})..."
		service_stop "$svc_mgr"
	fi
fi

mv -f "$staged_bin" "$target_bin"

if [ "$opt_pin_updates" -eq '1' ]; then
	if [ "$svc_mgr" = 'systemd' ]; then
		apply_systemd_pin
	else
		warn "--pin-updates ignored because systemd service '${opt_service}' is not active"
	fi
fi

self_copy="${install_dir}/${SCRIPT_NAME}"
if [ ! -f "$self_copy" ] || ! cmp -s "$0" "$self_copy"; then
	self_tmp="${self_copy}.tmp"
	cp "$0" "$self_tmp"
	chmod 0755 "$self_tmp"
	mv -f "$self_tmp" "$self_copy"
fi

saved_cli_path=''
if [ "$opt_no_cli" -eq '0' ] && [ -n "$opt_cli_path" ]; then
	cli_dir="$(dirname "$opt_cli_path")"
	if [ -d "$cli_dir" ] && [ -w "$cli_dir" ]; then
		ln -sf "$self_copy" "$opt_cli_path"
		saved_cli_path="$opt_cli_path"
	else
		warn "skipping CLI symlink at ${opt_cli_path} (parent directory not writable)"
	fi
fi

rollback_on_failure() {
	reason="$1"
	warn "${reason}; automatically rolling back to stock binary"
	service_stop "$svc_mgr" 2>/dev/null || true
	if [ -f "$backup_bin" ]; then
		rb_tmp="${install_dir}/.AdGuardHome.rollback.tmp"
		cp "$backup_bin" "$rb_tmp"
		apply_owner_caps "$rb_tmp" "$orig_owner" "$orig_caps"
		mv -f "$rb_tmp" "$target_bin"
		service_start "$svc_mgr" 2>/dev/null || true
	fi
	exit 1
}

if [ "$svc_mgr" != 'none' ] && { [ "$was_active" -eq '1' ] || [ "$svc_mgr" = 'systemd' ] || [ "$svc_mgr" = 'openrc' ]; }; then
	log "starting ${opt_service} (${svc_mgr})..."

	if ! service_start "$svc_mgr"; then
		rollback_on_failure 'service failed to start'
	fi

	ok='0'
	wait_i=0
	while [ "$wait_i" -lt '10' ]; do
		if service_is_active "$svc_mgr"; then
			if [ -z "$opt_probe_url" ]; then
				ok='1'
				break
			fi
			if http_probe_ok "${opt_probe_url%/}/control/stats/flow?window=1h"; then
				ok='1'
				break
			fi
		fi
		sleep 1
		wait_i=$((wait_i + 1))
	done

	if [ "$ok" -ne '1' ]; then
		rollback_on_failure 'post-start health check did not become ready within 10s'
	fi
elif [ -n "$opt_probe_url" ]; then
	if ! http_probe_ok "${opt_probe_url%/}/control/stats/flow?window=1h"; then
		die "HTTP probe failed at ${opt_probe_url%/}/control/stats/flow?window=1h"
	fi
fi

write_manifest "$manifest_file"

log "installed Insights overlay (${cand_ver})"
if [ -n "$saved_cli_path" ]; then
	log "helper ready: sudo ${saved_cli_path} status | reinstall | rollback"
else
	log "helper saved at: ${self_copy}"
fi
