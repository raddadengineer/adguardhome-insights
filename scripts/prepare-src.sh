#!/bin/sh

# Materializes the upstream AdGuard Home source tree pinned in UPSTREAM_REF,
# copies new Insights files from overlay/, and applies patches/upstream.patch.

set -e -f -u

usage() {
	cat <<'EOF'
Usage: prepare-src.sh [options]

Options:
  --out <dir>           Output directory for prepared source tree.
                        Default: .work/AdGuardHome
  --upstream-dir <dir>  Optional local AdGuardHome git clone to fetch from
                        instead of cloning over the network.
  --clean               Remove --out first if it already exists.
  -h, --help            Print this help message and exit.
EOF
}

out_dir='.work/AdGuardHome'
upstream_dir=''
clean='0'

while [ "$#" -gt 0 ]; do
	case "$1" in
	--out)
		[ "$#" -ge 2 ] || { echo 'error: --out requires an argument' 1>&2; exit 2; }
		out_dir="$2"
		shift 2
		;;
	--upstream-dir)
		[ "$#" -ge 2 ] || { echo 'error: --upstream-dir requires an argument' 1>&2; exit 2; }
		upstream_dir="$2"
		shift 2
		;;
	--clean)
		clean='1'
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

script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "${script_dir}/.." && pwd -P)"

[ -f "${repo_root}/UPSTREAM_REF" ] || { echo 'error: missing UPSTREAM_REF' 1>&2; exit 1; }
[ -d "${repo_root}/overlay" ] || { echo 'error: missing overlay/ directory' 1>&2; exit 1; }
[ -f "${repo_root}/patches/upstream.patch" ] || { echo 'error: missing patches/upstream.patch' 1>&2; exit 1; }

upstream_repo=''
upstream_commit=''
while IFS='=' read -r k v; do
	case "$k" in
	UPSTREAM_REPO)   upstream_repo="$v" ;;
	UPSTREAM_COMMIT) upstream_commit="$v" ;;
	*)               ;;
	esac
done < "${repo_root}/UPSTREAM_REF"

[ -n "$upstream_repo" ] || { echo 'error: UPSTREAM_REPO missing in UPSTREAM_REF' 1>&2; exit 1; }
[ -n "$upstream_commit" ] || { echo 'error: UPSTREAM_COMMIT missing in UPSTREAM_REF' 1>&2; exit 1; }

if [ -e "$out_dir" ]; then
	if [ "$clean" -eq '1' ]; then
		rm -rf "${out_dir:?}"
	elif [ -n "$(ls -A "$out_dir" 2>/dev/null || true)" ]; then
		echo "error: destination ${out_dir} already exists and is non-empty (pass --clean)" 1>&2
		exit 1
	fi
fi

mkdir -p "$out_dir"
out_abs="$(cd "$out_dir" && pwd -P)"

echo "preparing AdGuardHome upstream commit ${upstream_commit} -> ${out_dir}"
git -C "$out_abs" init -q
if [ -n "$upstream_dir" ]; then
	[ -d "$upstream_dir" ] || { echo "error: upstream dir not found: $upstream_dir" 1>&2; exit 1; }
	upstream_abs="$(cd "$upstream_dir" && pwd -P)"
	git -C "$out_abs" fetch -q --depth 1 "file://${upstream_abs}" "$upstream_commit" 2>/dev/null \
		|| git -C "$out_abs" fetch -q "$upstream_abs" "$upstream_commit"
else
	git -C "$out_abs" remote add origin "$upstream_repo"
	git -C "$out_abs" fetch -q --depth 1 origin "$upstream_commit"
fi
git -C "$out_abs" checkout -q --detach FETCH_HEAD

echo 'copying overlay files...'
(cd "${repo_root}/overlay" && tar -cf - .) | (cd "$out_abs" && tar -xf -)

echo 'applying patches/upstream.patch...'
git -C "$out_abs" apply --check "${repo_root}/patches/upstream.patch"
git -C "$out_abs" apply "${repo_root}/patches/upstream.patch"

echo "prepared source tree at ${out_abs}"
