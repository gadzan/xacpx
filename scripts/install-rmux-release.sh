#!/usr/bin/env bash
# Install a pinned RMUX GitHub release into a prefix (default: ~/.local).
# Does not download "latest" — version is fixed for reproducible smoke/CI.
# Verifies SHA-256 before extract. Never executes a downloaded install.sh.
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

expected_sha256() {
  # v0.10.0 SHA256SUMS from https://github.com/Helvesec/rmux/releases/tag/v0.10.0
  case "$1" in
    rmux-0.10.0-linux-x86_64.tar.gz) echo "1bec11eff08c3313c3a400196e7a93d00b8ad4a24f81ef13debb03355c2696c5" ;;
    rmux-0.10.0-linux-aarch64.tar.gz) echo "7e916560ea0fb90864b8c24e5d0f81b4e3e0b013b8aad5ab53839d7e8e5e1926" ;;
    rmux-0.10.0-macos-aarch64.tar.gz) echo "aac857519071f680be53aa9a328dc0cd04c2abe66ec726f78aa9e26337c5ef7b" ;;
    rmux-0.10.0-macos-x86_64.tar.gz) echo "b897898eadc4d96c6d555b79affd834bd488013c44f8c6f815bb5195eafd1e0a" ;;
    rmux-0.10.0-windows-x86_64.zip) echo "e315e2d51d927ba9621732812c0f932c862d05f4b677dbf3cab76f0d27372a70" ;;
    *) echo "" ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

expected="$(expected_sha256 "$asset")"
if [[ -z "$expected" ]]; then
  echo "no pinned SHA-256 for $asset (RMUX_VERSION=$RMUX_VERSION); refusing to install" >&2
  exit 1
fi

url="https://github.com/${REPO}/releases/download/v${RMUX_VERSION}/${asset}"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading $url"
curl -fsSL "$url" -o "$tmpdir/$asset"

actual="$(sha256_of "$tmpdir/$asset")"
if [[ "$actual" != "$expected" ]]; then
  echo "SHA-256 mismatch for $asset" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

mkdir -p "$PREFIX"
if [[ "$asset" == *.zip ]]; then
  unzip -q "$tmpdir/$asset" -d "$tmpdir/extract"
else
  mkdir -p "$tmpdir/extract"
  tar -xzf "$tmpdir/$asset" -C "$tmpdir/extract"
fi

# Copy bin/ + libexec/ from the package root. Do not execute a bundled install.sh.
src=""
for candidate in "$tmpdir/extract"/*; do
  if [[ -d "$candidate" ]]; then
    src="$candidate"
    break
  fi
done
if [[ -z "$src" ]]; then src="$tmpdir/extract"; fi

if [[ -d "$src/bin" ]]; then
  mkdir -p "$PREFIX/bin"
  cp -R "$src/bin/." "$PREFIX/bin/"
fi
if [[ -d "$src/libexec" ]]; then
  mkdir -p "$PREFIX/libexec"
  cp -R "$src/libexec/." "$PREFIX/libexec/"
fi
if [[ ! -d "$src/bin" && ! -d "$src/libexec" ]]; then
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
