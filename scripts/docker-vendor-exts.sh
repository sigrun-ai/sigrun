#!/bin/sh
# Vendor the sigrun extension deps into .docker-ext/ for the Docker build
# (the image build can't reach the forgejo host over tailscale SSH).
# Run before docker build: bash scripts/docker-vendor-exts.sh
set -e
cd "$(dirname "$0")/.."

rm -rf .docker-ext
mkdir -p .docker-ext

for repo in sigrun-ext-memory-markdown sigrun-ext-approvals; do
  echo "cloning $repo..."
  git clone --depth 1 "${SIGRUN_VENDOR_GIT_URL:-ssh://git@git.example.invalid/sigrun-ai}/$repo.git" ".docker-ext/$repo"
done

# The package names match the repo names (sigrun-ext-memory-markdown,
# sigrun-ext-approvals) — the clone dirs already carry the right names.
# The rename below stays as a no-op safety net if that ever drifts.
for dir in .docker-ext/*/; do
  name=$(basename "$dir")
  pkg=$(python3 -c "import json; print(json.load(open('$dir/package.json'))['name'])")
  if [ "$name" != "$pkg" ]; then
    mv ".docker-ext/$name" ".docker-ext/$pkg"
  fi
done

echo "vendored:" && ls .docker-ext/
