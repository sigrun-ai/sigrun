#!/bin/sh
# sigrun deploy-time tools installer (image workflow spec §5) — the
# chart's tools initContainer entrypoint. Called as
#
#   tools-install.sh DIR SPEC...    SPEC = name@version
#
# Installs kubectl-class STATIC binaries onto the DATA VOLUME (DIR/bin),
# never into the image: version churn is a deploy concern, so the image
# ships only this script and the values file picks versions.
#
# - Fixed URL catalog (kubectl/helm/talosctl/flux/k9s — the
#   hermes-pantheon set, data-driven): adding a tool = editing the
#   catalog below + image rebuild (rare); USING one = values only.
#   Each entry carries its archive SHAPE — which member to extract and
#   where it lands — because `tar -xz` vs raw-binary is per-release-site
#   fact, not something to guess at fetch time.
# - `DIR/.catalog-sha` = sha256 of the sorted spec list: unchanged list
#   → full no-op (pod restarts don't re-download; hermes pattern).
# - Fail-loud (Review Focus 5): unknown tool or failed fetch exits
#   nonzero NAMING the spec, so the CrashLoop event points at the exact
#   values line. A failed run never leaves a hash file behind — a later
#   boot must not short-circuit into a half-installed tools dir.
set -eu

# TEST SEAM (not config surface): TOOL_URL_OVERRIDE_<NAME> replaces one
# catalog entry's URL so the offline test suite can point it at a local
# fixture or an unreachable port. No operator-facing documentation; the
# catalog above stays the real one.

if [ "$#" -lt 1 ]; then
	echo "tools-install.sh: usage: tools-install.sh DIR SPEC..." >&2
	exit 1
fi

DIR="$1"
shift

[ "$#" -ge 1 ] || {
	echo "tools-install.sh: no specs given (values sigrun.tools.packages empty?)" >&2
	exit 1
}

mkdir -p "$DIR/bin"

# catalog: tool|version-template|shape|member (member empty = raw
# binary, else the path inside the tarball that lands as DIR/bin/name).
# Templates follow each project's official release layout:
#   kubectl   raw   dl.k8s.io/release/<v>/bin/linux/amd64/kubectl
#   helm      tar   get.helm.sh/helm-<v>-linux-amd64.tar.gz (linux-amd64/helm)
#   talosctl  raw   github siderolabs/talos talosctl-linux-amd64
#   flux      tar   github fluxcd/flux2 flux_<noV>_linux_amd64.tar.gz (flux)
#   k9s       tar   github derailed/k9s k9s_Linux_amd64.tar.gz (k9s)
catalog_url() {
	_name="$1"
	_version="$2"
	case "$_name" in
	kubectl)
		printf 'https://dl.k8s.io/release/%s/bin/linux/amd64/kubectl' "$_version"
		;;
	helm)
		printf 'https://get.helm.sh/helm-%s-linux-amd64.tar.gz' "$_version"
		;;
	talosctl)
		printf 'https://github.com/siderolabs/talos/releases/download/%s/talosctl-linux-amd64' "$_version"
		;;
	flux)
		# flux tags carry the v; the ASSET name does not (flux_2.1_...).
		_nv="$(printf '%s' "$_version" | sed 's/^v//')"
		printf 'https://github.com/fluxcd/flux2/releases/download/%s/flux_%s_linux_amd64.tar.gz' "$_version" "$_nv"
		;;
	k9s)
		printf 'https://github.com/derailed/k9s/releases/download/%s/k9s_Linux_amd64.tar.gz' "$_version"
		;;
	*)
		return 1
		;;
	esac
}

catalog_member() {
	_name="$1"
	case "$_name" in
	kubectl | talosctl) return 0 ;;
	helm) printf 'linux-amd64/helm' ;;
	flux) printf 'flux' ;;
	k9s) printf 'k9s' ;;
	*) return 1 ;;
	esac
}

# The short-circuit hash: sha256 of the sorted spec list, one per line
# — of the SET, not the chart's argv order (reordering values must not
# re-download). Trailing newline keeps `sort | sha256sum` and this
# script's printf byte-identical.
expected_sha="$(printf '%s\n' "$@" | sort | sha256sum | cut -d' ' -f1)"
if [ -f "$DIR/.catalog-sha" ] &&
	[ "$(cat "$DIR/.catalog-sha")" = "$expected_sha" ]; then
	exit 0
fi

for spec in "$@"; do
	name="${spec%%@*}"
	version="${spec#*@}"
	if ! url="$(catalog_url "$name" "$version")"; then
		echo "tools-install.sh: unknown tool in spec '$spec' (catalog: kubectl helm talosctl flux k9s)" >&2
		exit 1
	fi
	# TEST SEAM consumption (see comment above).
	eval "override=\${TOOL_URL_OVERRIDE_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')-}"
	if [ -n "${override:-}" ]; then
		url="$override"
	fi

	member="$(catalog_member "$name" || true)"
	# Scratch files beside the destination, mv'd into place only on
	# success: a failed version bump must never destroy the previously
	# working binary (the extract redirect would truncate it), a partial
	# download never becomes the binary, and no temp DIR cleanup exists —
	# a recursive rm on a variable path is exactly the footgun this
	# script refuses to ship. Stale scratches from a killed run are
	# non-executable `.part`/`.incoming` names PATH never picks up, and
	# the next run overwrites them.
	part="$DIR/bin/$name.part"
	incoming="$DIR/bin/$name.incoming"
	if ! curl -fsSL -o "$part" "$url"; then
		rm -f "$part"
		echo "tools-install.sh: fetch failed for spec '$spec' (url: $url)" >&2
		exit 1
	fi
	bin="$DIR/bin/$name"
	if [ -n "$member" ]; then
		# -O streams the member to stdout: extracting into a scratch dir
		# (and cleaning it up) is avoided whole-cloth.
		if ! tar -xzOf "$part" "$member" >"$incoming"; then
			rm -f "$part" "$incoming"
			echo "tools-install.sh: extract failed for spec '$spec' (member: $member)" >&2
			exit 1
		fi
		rm -f "$part"
		mv "$incoming" "$bin"
	else
		mv "$part" "$bin"
	fi
	chmod +x "$bin"
	echo "installed $spec -> $bin"
done

# Hash written only after every spec succeeded (half-installed dirs
# must re-run: see the failed-fetch contract above).
printf '%s\n' "$expected_sha" >"$DIR/.catalog-sha"
