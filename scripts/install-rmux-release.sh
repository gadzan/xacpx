#!/usr/bin/env bash
# Install a pinned RMUX GitHub release into a prefix (default: ~/.local).
# Does not download "latest" — version is fixed for reproducible smoke/CI.
set -euo pipefail

RMUX_VERSION="${RMUX_VERSION:-0.10.0}"
PREFIX="${RMUX_PREFIX:-$HOME/.local}"
REPO="${RMUX_REPO:-Helvesec/rmux}"

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  MINGW*|MSYS*|CYGWIN*) os=windows ;;
  *) echo "unsupported OS: $uname_s" >&2; exit 1 ;;
esac
case "$uname_m" in
  x86_64|amd64) arch=x86_64 ;;
  arm64|aarch64) arch=aarch64 ;;
  *) echo "unsupported arch: $uname_m" >&2; exit 1 ;;
esac

if [[ "$os" == "windows" ]]; then
  asset="rmux-${RMUX_VERSION}-windows-${arch}.zip"
else
  asset="rmux-${RMUX_VERSION}-${os}-${arch}.tar.gz"
fi

url="https://github.com/${REPO}/releases/download/v${RMUX_VERSION}/${asset}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading $url"
curl -fsSL "$url" -o "$tmpdir/$asset"

mkdir -p "$PREFIX"
if [[ "$asset" == *.zip ]]; then
  unzip -q "$tmpdir/$asset" -d "$tmpdir/extract"
else
  mkdir -p "$tmpdir/extract"
  tar -xzf "$tmpdir/$asset" -C "$tmpdir/extract"
fi

# Prefer upstream install.sh when present (preserves bin/ + libexec/ layout).
install_sh="$(find "$tmpdir/extract" -name install.sh -type f | head -n 1)"
if [[ -n "$install_sh" ]]; then
  bash "$install_sh" --prefix "$PREFIX"
else
  # Windows zip: copy package root contents into PREFIX.
  src="$(find "$tmpdir/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -z "$src" ]]; then src="$tmpdir/extract"; fi
  mkdir -p "$PREFIX"
  cp -R "$src"/. "$PREFIX"/
fi

helper="$PREFIX/libexec/rmux/rmux"
if [[ -x "$helper" ]]; then
  echo "RMUX_SDK_DAEMON_BINARY=$helper"
elif [[ -x "$PREFIX/libexec/rmux/rmux.exe" ]]; then
  echo "RMUX_SDK_DAEMON_BINARY=$PREFIX/libexec/rmux/rmux.exe"
else
  echo "warn: libexec helper not found under $PREFIX; try PATH rmux" >&2
fi
