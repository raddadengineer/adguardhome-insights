#!/bin/sh

# Prepares upstream AdGuardHome + Insights overlay and builds multi-architecture
# overlay release bundles, checksums.txt, and Docker prebuilt binaries.

set -e -f -u

usage() {
	cat <<'EOF'
Usage: build-insights-bundle.sh [options]

Options:
  --targets "<os>/<arch> ..."  Space-separated build targets.
                               Supported: host, linux/386, linux/amd64,
                               linux/arm64, linux/armv6, linux/armv7,
                               darwin/amd64, darwin/arm64.
                               Default: "linux/amd64 linux/arm64 linux/armv7"
  --out-dir <dir>              Output directory. Default: dist/insights
  --work-dir <dir>             Prepared AdGuardHome work directory.
                               Default: .work/AdGuardHome
  --upstream-dir <dir>         Optional local AdGuardHome git clone passed to
                               prepare-src.sh.
  --version <ver>              Version string stamped via ldflags.
                               Defaults to v0.1.0+insights.<sha>.
  --channel <ch>               Build channel: development, edge, beta, release,
                               or candidate. Default: development
  --skip-prepare               Reuse existing --work-dir without re-preparing.
  --skip-frontend              Reuse existing build/static inside --work-dir.
  -h, --help                   Print this help message and exit.
EOF
}

targets='linux/amd64 linux/arm64 linux/armv7'
out_dir='dist/insights'
work_dir='.work/AdGuardHome'
upstream_dir=''
version=''
channel='development'
skip_prepare='0'
skip_frontend='0'

while [ "$#" -gt 0 ]; do
	case "$1" in
	--targets)
		[ "$#" -ge 2 ] || { echo 'error: --targets requires an argument' 1>&2; exit 2; }
		targets="$2"
		shift 2
		;;
	--out-dir)
		[ "$#" -ge 2 ] || { echo 'error: --out-dir requires an argument' 1>&2; exit 2; }
		out_dir="$2"
		shift 2
		;;
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
	--version)
		[ "$#" -ge 2 ] || { echo 'error: --version requires an argument' 1>&2; exit 2; }
		version="$2"
		shift 2
		;;
	--channel)
		[ "$#" -ge 2 ] || { echo 'error: --channel requires an argument' 1>&2; exit 2; }
		channel="$2"
		shift 2
		;;
	--skip-prepare)
		skip_prepare='1'
		shift
		;;
	--skip-frontend)
		skip_frontend='1'
		shift
		;;
	-h|--help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown option: $1" 1>&2
		usage 1>&2
		exit 2
		;;
	esac
done

case "$channel" in
development|edge|beta|release|candidate)
	;;
*)
	echo "error: invalid --channel '$channel'" 1>&2
	exit 2
	;;
esac

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "${script_dir}/.." && pwd -P)"

[ -f "${repo_root}/scripts/adguardhome-insights.sh" ] \
	|| { echo 'error: missing scripts/adguardhome-insights.sh' 1>&2; exit 1; }
[ -f "${repo_root}/scripts/prepare-src.sh" ] \
	|| { echo 'error: missing scripts/prepare-src.sh' 1>&2; exit 1; }

go_bin="${GO:-go}"
if ! command -v "$go_bin" >/dev/null 2>&1; then
	echo "error: Go toolchain not found ($go_bin)" 1>&2
	exit 1
fi

tmp_root=''
cleanup() {
	if [ -n "$tmp_root" ] && [ -d "$tmp_root" ]; then
		rm -rf "${tmp_root:?}"
	fi
}
trap cleanup EXIT INT TERM

if [ "$skip_prepare" -eq '0' ] || [ ! -f "${work_dir}/go.mod" ]; then
	if [ -n "$upstream_dir" ]; then
		sh "${repo_root}/scripts/prepare-src.sh" --clean --out "$work_dir" --upstream-dir "$upstream_dir"
	else
		sh "${repo_root}/scripts/prepare-src.sh" --clean --out "$work_dir"
	fi
fi

work_abs="$(cd "$work_dir" && pwd -P)"
[ -f "${work_abs}/go.mod" ] && [ -f "${work_abs}/scripts/make/go-build.sh" ] \
	|| { echo "error: invalid prepared work-dir: ${work_abs}" 1>&2; exit 1; }

if [ "$skip_frontend" -eq '0' ]; then
	if [ ! -d "${work_abs}/client_v2/node_modules" ]; then
		echo 'installing client_v2 dependencies...'
		npm --prefix "${work_abs}/client_v2" ci --quiet --no-progress
	fi
	echo 'building frontend bundle (client_v2)...'
	npm --prefix "${work_abs}/client_v2" run build-prod
fi

if [ ! -d "${work_abs}/build/static" ] || [ -z "$(ls -A "${work_abs}/build/static" 2>/dev/null)" ]; then
	echo "error: ${work_abs}/build/static is missing or empty; run without --skip-frontend" 1>&2
	exit 1
fi

commit_sha="$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || git -C "$work_abs" rev-parse --short HEAD 2>/dev/null || echo 'local')"
built_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

if [ -z "$version" ]; then
	base_ver="$(git -C "$repo_root" describe --tags --abbrev=0 2>/dev/null || echo 'v0.1.0')"
	case "$base_ver" in
	*insights*)
		version="$base_ver"
		;;
	*+*)
		version="${base_ver}.insights"
		;;
	*)
		version="${base_ver}+insights.${commit_sha}"
		;;
	esac
fi

mkdir -p "$out_dir" "${out_dir}/docker"
out_dir_abs="$(cd "$out_dir" && pwd -P)"
tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/agh-insights-build.XXXXXX")"

resolve_target() {
	req="$1"
	if [ "$req" = 'host' ]; then
		host_os="$("$go_bin" env GOOS)"
		host_arch="$("$go_bin" env GOARCH)"
		if [ "$host_arch" = 'arm' ]; then
			host_arm="$("$go_bin" env GOARM)"
			case "$host_arm" in
			6) req="${host_os}/armv6" ;;
			*) req="${host_os}/armv7" ;;
			esac
		else
			req="${host_os}/${host_arch}"
		fi
	fi

	case "$req" in
	linux/386)
		t_os='linux'; t_arch='386'; t_arm=''; t_label='386'; t_docker='386_' ;;
	linux/amd64)
		t_os='linux'; t_arch='amd64'; t_arm=''; t_label='amd64'; t_docker='amd64_' ;;
	linux/arm64)
		t_os='linux'; t_arch='arm64'; t_arm=''; t_label='arm64'; t_docker='arm64_' ;;
	linux/armv6)
		t_os='linux'; t_arch='arm'; t_arm='6'; t_label='armv6'; t_docker='arm_v6' ;;
	linux/armv7)
		t_os='linux'; t_arch='arm'; t_arm='7'; t_label='armv7'; t_docker='arm_v7' ;;
	darwin/amd64)
		t_os='darwin'; t_arch='amd64'; t_arm=''; t_label='amd64'; t_docker='amd64_' ;;
	darwin/arm64)
		t_os='darwin'; t_arch='arm64'; t_arm=''; t_label='arm64'; t_docker='arm64_' ;;
	*)
		echo "error: unsupported target '$req'" 1>&2
		exit 1
		;;
	esac
}

sha256_line() {
	file_name="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$file_name"
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$file_name"
	else
		echo 'error: neither sha256sum nor shasum found' 1>&2
		exit 1
	fi
}

echo "building AdGuardHome Insights bundles: version=${version} channel=${channel}"

for raw_target in $targets; do
	resolve_target "$raw_target"
	stage_dir="${tmp_root}/${t_os}_${t_label}"
	mkdir -p "$stage_dir"

	bin_out="${stage_dir}/AdGuardHome"
	echo "-> compiling ${t_os}/${t_label}..."
	(
		cd "$work_abs"
		if [ -n "$t_arm" ]; then
			GOOS="$t_os" GOARCH="$t_arch" GOARM="$t_arm" \
				CHANNEL="$channel" VERSION="$version" OUT="$bin_out" \
				sh ./scripts/make/go-build.sh
		else
			env -u GOARM GOOS="$t_os" GOARCH="$t_arch" \
				CHANNEL="$channel" VERSION="$version" OUT="$bin_out" \
				sh ./scripts/make/go-build.sh
		fi
	)
	chmod 0755 "$bin_out"

	cat > "${stage_dir}/INSIGHTS_VERSION" <<EOF
VERSION=${version}
CHANNEL=${channel}
COMMIT=${commit_sha}
TARGET=${t_os}/${t_label}
BUILT_AT=${built_at}
EOF

	cp "${repo_root}/scripts/adguardhome-insights.sh" "${stage_dir}/adguardhome-insights.sh"
	chmod 0755 "${stage_dir}/adguardhome-insights.sh"

	archive_name="AdGuardHome-insights_${t_os}_${t_label}.tar.gz"
	tar -C "$stage_dir" -czf "${out_dir_abs}/${archive_name}" \
		AdGuardHome adguardhome-insights.sh INSIGHTS_VERSION

	docker_bin="${out_dir_abs}/docker/AdGuardHome_${t_os}_${t_docker}"
	cp "$bin_out" "$docker_bin"
	chmod 0755 "$docker_bin"

	echo "   packed ${out_dir}/${archive_name}"
done

cp "${repo_root}/scripts/adguardhome-insights.sh" "${out_dir_abs}/adguardhome-insights.sh"
chmod 0755 "${out_dir_abs}/adguardhome-insights.sh"

if [ -f "${repo_root}/packaging/docker-compose.insights.yml" ]; then
	cp "${repo_root}/packaging/docker-compose.insights.yml" "${out_dir_abs}/docker-compose.insights.yml"
	chmod 0644 "${out_dir_abs}/docker-compose.insights.yml"
fi

checksum_tmp="${tmp_root}/checksums.txt"
: > "$checksum_tmp"
(
	cd "$out_dir_abs"
	find . -maxdepth 1 -type f \( -name 'AdGuardHome-insights_*.tar.gz' -o -name 'adguardhome-insights.sh' -o -name 'docker-compose.insights.yml' \) -print \
		| sed 's|^\./||' \
		| sort \
		| while IFS= read -r archive; do
			sha256_line "$archive" >> "$checksum_tmp"
		done
)
cp "$checksum_tmp" "${out_dir_abs}/checksums.txt"
chmod 0644 "${out_dir_abs}/checksums.txt"

echo "done: ${out_dir_abs}/checksums.txt"
