#!/bin/sh
# Vendor the sigrun extension deps into .docker-ext/ for the Docker build
# (the image build can't reach the forgejo host over tailscale SSH).
# Run before docker build: bash scripts/docker-vendor-exts.sh
#
# Two sources (Task 8):
# - forgejo (over the tailscale SSH alias): sigrun-memory-markdown,
#   sigrun-approvals, sigrun-ext-mcp.
# - LOCAL sibling repos (no forgejo remote yet): sigrun-ext-codemode +
#   sigrun-ext-tool-search, shallow file:// clones from
#   $SIGRUN_VENDOR_LOCAL_ROOT (default ~/repos). A missing local repo
#   fails LOUD naming the repo — vendoring must not silently skip: the
#   image boot canary would only surface the gap after boot.
set -e
cd "$(dirname "$0")/.."

LOCAL_ROOT="${SIGRUN_VENDOR_LOCAL_ROOT:-$HOME/repos}"

rm -rf .docker-ext
mkdir -p .docker-ext

for repo in sigrun-memory-markdown sigrun-approvals sigrun-ext-mcp; do
  echo "cloning $repo from forgejo..."
  git clone --depth 1 "ssh://git@git.example.invalid/sigrun-ai/$repo.git" ".docker-ext/$repo"
done

for repo in sigrun-ext-codemode sigrun-ext-tool-search; do
  src="$LOCAL_ROOT/$repo"
  if [ ! -d "$src/.git" ]; then
    echo "ERROR: local extension repo $src missing — set SIGRUN_VENDOR_LOCAL_ROOT to its parent (Task 8: fail loud, the boot canary would only vacuum after boot)" >&2
    exit 1
  fi
  echo "cloning $repo from $src..."
  git clone --depth 1 "file://$src" ".docker-ext/$repo"
done

# The package names in the extension repos must match what sigrun's
# package.json expects (sigrun-ext-memory-markdown, sigrun-ext-approvals).
# The clone dirs match the repo names; rename to package names.
# (sigrun-ext-mcp / -codemode / -tool-search already match; the loop is a
# no-op for them.)
for dir in .docker-ext/*/; do
  name=$(basename "$dir")
  pkg=$(python3 -c "import json; print(json.load(open('$dir/package.json'))['name'])")
  if [ "$name" != "$pkg" ]; then
    mv ".docker-ext/$name" ".docker-ext/$pkg"
  fi
done

echo "vendored:" && ls .docker-ext/
