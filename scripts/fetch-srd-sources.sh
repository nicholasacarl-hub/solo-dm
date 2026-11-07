#!/usr/bin/env bash
# Fetch the upstream SRD 5.2.1 sources that scripts/build-srd.mjs converts into public/srd/.
#
# Licensing: both repositories are used only for System Reference Document 5.2.1 content, which
# Wizards of the Coast LLC publishes under the Creative Commons Attribution 4.0 International License
# (CC-BY-4.0). Open5e's artwork is licensed separately (CC-BY-NC-4.0) and is NOT fetched or used,
# and only Open5e's "srd-2024" document plus its core lookup lists are checked out (no other
# publishers). See ATTRIBUTION.md for the attribution statement.
#
# Usage: scripts/fetch-srd-sources.sh [DIR]     (default: ./.srd-sources, which is git-ignored)
# Then:  npm run build:srd                      (or SRD_SOURCES_DIR=DIR npm run build:srd)
#
# Each repository is a shallow, blobless, sparse checkout of one pinned commit, so a re-run always
# yields the same files. The checkouts are treated as data: nothing inside them is executed.
set -euo pipefail

DEST="${1:-./.srd-sources}"

# Pinned commits (see docs/research/srd-sources.md).
YOUR5E_URL="https://github.com/your5e/5e-srd-markdown"
YOUR5E_COMMIT="f1f5060fd975aa2ffc3e4b336560ded479934d80"
OPEN5E_URL="https://github.com/open5e/open5e-api"
OPEN5E_COMMIT="bdcddf2b5f7995c42ac89722d8da563346b6744a" # on branch "staging"

# sparse_clone <dir> <url> <commit> <pattern>...
sparse_clone() {
  local dir="$1" url="$2" commit="$3"
  shift 3
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)" = "$commit" ]; then
    echo "✓ $dir already at ${commit:0:7}"
    return
  fi
  rm -rf "$dir"
  # A blobless clone sets the remote up as a partial-clone promisor; file contents are fetched
  # lazily, and only for the sparse paths below.
  git clone --quiet --filter=blob:none --no-checkout --depth 1 "$url" "$dir"
  # Non-cone sparse checkout: only the listed paths are written to the working tree.
  git -C "$dir" config core.sparseCheckout true
  git -C "$dir" config core.sparseCheckoutCone false
  printf '%s\n' "$@" > "$dir/.git/info/sparse-checkout"
  # The pinned commit may no longer be a branch tip, so fetch it by hash.
  if ! git -C "$dir" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    git -C "$dir" fetch --quiet --depth 1 --filter=blob:none origin "$commit"
  fi
  git -C "$dir" checkout --quiet --detach "$commit"
  if [ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]; then
    echo "✗ $dir: expected commit $commit" >&2
    exit 1
  fi
  echo "✓ $dir at ${commit:0:7}"
}

mkdir -p "$DEST"

sparse_clone "$DEST/your5e-srd-markdown" "$YOUR5E_URL" "$YOUR5E_COMMIT" \
  '/README.md' \
  '/dnd/521/markdown/' \
  '/dnd/521/SRD_CC_v5.2.1.md'

sparse_clone "$DEST/open5e-api" "$OPEN5E_URL" "$OPEN5E_COMMIT" \
  '/LICENSE.md' \
  '/README.md' \
  '/data/v2/License.json' \
  '/data/v2/open5e/core/' \
  '/data/v2/wizards-of-the-coast/srd-2024/'

echo "SRD sources ready in $DEST. Next: SRD_SOURCES_DIR=$DEST npm run build:srd"
