#!/bin/sh

# End-to-end verification test for prepare-src.sh, build-insights-bundle.sh,
# and adguardhome-insights.sh using a real host Insights build and a mock
# existing AdGuard Home installation directory.

set -e -f -u

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "${script_dir}/.." && pwd -P)"

[ -f "${repo_root}/UPSTREAM_REF" ] || { echo 'error: missing UPSTREAM_REF' 1>&2; exit 1; }

work_dir=''
upstream_dir=''

while [ "$#" -gt 0 ]; do
	case "$1" in
	--work-dir)
		[ "$#" -ge 2 ] || { echo 'error: --work-dir requires an argument' 1>&2; exit 2; }
		work_dir="$2"
		shift 2
		;;
	--upstream-dir)
		[ "$#" -ge 2 ] || { echo 'error: --upstream-dir requires an argument' 1>&2; exit 2; }
		upstream_dir="$2"
		shift 2
		;;
	-h|--help)
		echo 'Usage: test-insights-installer.sh [--work-dir <dir>] [--upstream-dir <dir>]'
		exit 0
		;;
	*)
		echo "error: unknown option: $1" 1>&2
		exit 2
		;;
	esac
done

tmp_root=''
cleanup() {
	if [ -n "$tmp_root" ] && [ -d "$tmp_root" ]; then
		rm -rf "${tmp_root:?}"
	fi
}
trap cleanup EXIT INT TERM

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/agh-insights-test.XXXXXX")"
dist_dir="${tmp_root}/dist"
install_dir="${tmp_root}/existing-agh"
cli_bin="${tmp_root}/bin/adguardhome-insights"
mkdir -p "$dist_dir" "$install_dir" "$(dirname "$cli_bin")"

echo '1) building host Insights bundle...'
if [ -n "$work_dir" ]; then
	if [ -d "${work_dir}/build/static" ] && [ -n "$(ls -A "${work_dir}/build/static" 2>/dev/null)" ]; then
		sh "${repo_root}/scripts/build-insights-bundle.sh" \
			--work-dir "$work_dir" \
			--skip-prepare \
			--skip-frontend \
			--targets host \
			--out-dir "$dist_dir"
	else
		sh "${repo_root}/scripts/build-insights-bundle.sh" \
			--work-dir "$work_dir" \
			--skip-prepare \
			--targets host \
			--out-dir "$dist_dir"
	fi
elif [ -n "$upstream_dir" ]; then
	sh "${repo_root}/scripts/build-insights-bundle.sh" \
		--work-dir "${tmp_root}/src" \
		--upstream-dir "$upstream_dir" \
		--targets host \
		--out-dir "$dist_dir"
else
	sh "${repo_root}/scripts/build-insights-bundle.sh" \
		--work-dir "${tmp_root}/src" \
		--targets host \
		--out-dir "$dist_dir"
fi

go_bin="${GO:-go}"
host_os="$("$go_bin" env GOOS)"
host_arch="$("$go_bin" env GOARCH)"
if [ "$host_arch" = 'arm' ]; then
	case "$("$go_bin" env GOARM)" in
	6) host_arch='armv6' ;;
	*) host_arch='armv7' ;;
	esac
fi

bundle_path="${dist_dir}/AdGuardHome-insights_${host_os}_${host_arch}.tar.gz"
[ -f "$bundle_path" ] || { echo "missing bundle: $bundle_path" 1>&2; exit 1; }
[ -f "${dist_dir}/checksums.txt" ] || { echo 'missing checksums.txt' 1>&2; exit 1; }

# Minimal valid configuration accepted by AdGuardHome --check-config.
cat > "${install_dir}/AdGuardHome.yaml" <<EOF
http:
  address: 127.0.0.1:0
dns:
  bind_hosts:
    - 127.0.0.1
  port: 0
  upstream_dns:
    - 1.1.1.1
schema_version: 29
EOF

write_mock_stock() {
	ver="$1"
	cat > "${install_dir}/AdGuardHome" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
	printf 'AdGuard Home, version %s\n' '${ver}'
	exit 0
fi
exit 0
EOF
	chmod 0755 "${install_dir}/AdGuardHome"
}

write_mock_stock 'v0.107.57'
installer="${repo_root}/scripts/adguardhome-insights.sh"

echo '2) verifying NOT_INSTALLED status...'
out="$(sh "$installer" status --dir "$install_dir" --no-service)"
printf '%s\n' "$out" | grep -q 'State:         NOT_INSTALLED'
if sh "$installer" status --dir "$install_dir" --no-service --strict >/dev/null 2>&1; then
	echo 'expected status --strict to fail before install' 1>&2
	exit 1
fi

echo '3) verifying --dry-run leaves binary untouched...'
sh "$installer" install \
	--dir "$install_dir" \
	--bundle "$bundle_path" \
	--no-service \
	--no-cli \
	--dry-run
"${install_dir}/AdGuardHome" --version | grep -q 'v0.107.57'
[ ! -f "${install_dir}/AdGuardHome.stock.bak" ]

echo '4) verifying bad SHA-256 aborts before modifying stock binary...'
if sh "$installer" install \
	--dir "$install_dir" \
	--bundle "$bundle_path" \
	--sha256 '0000000000000000000000000000000000000000000000000000000000000000' \
	--no-service \
	--no-cli >/dev/null 2>&1; then
	echo 'expected bad SHA-256 install to fail' 1>&2
	exit 1
fi
"${install_dir}/AdGuardHome" --version | grep -q 'v0.107.57'
[ ! -f "${install_dir}/AdGuardHome.stock.bak" ]

echo '5) running real install with sibling checksums.txt verification & --check-config...'
sh "$installer" install \
	--dir "$install_dir" \
	--bundle "$bundle_path" \
	--cli-path "$cli_bin" \
	--no-service
[ -L "$cli_bin" ]
"${install_dir}/AdGuardHome" --version | grep -qi 'insights'
"${install_dir}/AdGuardHome.stock.bak" --version | grep -q 'v0.107.57'
sh "$installer" status --dir "$install_dir" --no-service --strict >/dev/null

echo '6) simulating upstream AdGuard Home upgrade to v0.107.58...'
write_mock_stock 'v0.107.58'
out_upg="$(sh "$installer" status --dir "$install_dir" --no-service)"
printf '%s\n' "$out_upg" | grep -q 'State:         OVERRIDDEN_BY_UPGRADE'
if sh "$installer" status --dir "$install_dir" --no-service --strict >/dev/null 2>&1; then
	echo 'expected status --strict to fail after upgrade override' 1>&2
	exit 1
fi

echo '7) testing reinstall from remembered manifest (updates stock backup to v0.107.58)...'
"$cli_bin" reinstall --dir "$install_dir" --no-service
"${install_dir}/AdGuardHome" --version | grep -qi 'insights'
"${install_dir}/AdGuardHome.stock.bak" --version | grep -q 'v0.107.58'
"$cli_bin" status --dir "$install_dir" --no-service --strict >/dev/null

echo '8) testing rollback restores stock v0.107.58 & cleans up...'
"$cli_bin" rollback --dir "$install_dir" --no-service --remove-cli
"${install_dir}/AdGuardHome" --version | grep -q 'v0.107.58'
[ ! -f "${install_dir}/.insights-overlay.env" ]
[ ! -e "$cli_bin" ]
out_rb="$(sh "$installer" status --dir "$install_dir" --no-service)"
printf '%s\n' "$out_rb" | grep -q 'State:         NOT_INSTALLED'

echo 'ALL INSIGHTS INSTALLER E2E CHECKS PASSED'
