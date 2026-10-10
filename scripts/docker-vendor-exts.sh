#!/bin/sh
# Vendor the sigrun extension deps into .docker-ext/ for the Docker build
# (the image build can't reach the forgejo host over tailscale SSH).
# Run before docker build: bash scripts/docker-vendor-exts.sh
set -e
cd "$(dirname "$0")/.."

rm -rf .docker-ext
mkdir -p .docker-ext

for repo in sigrun-memory-markdown sigrun-approvals; do
  echo "cloning $repo..."
  git clone --depth 1 "ssh://git@git.example.invalid/sigrun-ai/$repo.git" ".docker-ext/$repo"
done

# The package names in the extension repos must match what sigrun's
# package.json expects (sigrun-ext-memory-markdown, sigrun-ext-approvals).
# The clone dirs match the repo names; rename to package names.
for dir in .docker-ext/*/; do
  name=$(basename "$dir")
  pkg=$(python3 -c "import json; print(json.load(open('$dir/package.json'))['name'])")
  if [ "$name" != "$pkg" ]; then
    mv ".docker-ext/$name" ".docker-ext/$pkg"
  fi
done

echo "vendored:" && ls .docker-ext/
