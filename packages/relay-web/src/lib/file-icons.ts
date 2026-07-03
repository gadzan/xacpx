import type { Component } from "vue";
import {
  File as FileIcon, FileCode, FileJson, FileText, FileImage, FileType,
  FileCog, FileLock, FileTerminal, FileArchive,
} from "lucide-vue-next";

const EXT_ICON: Record<string, Component> = {
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode, mjs: FileCode, cjs: FileCode,
  vue: FileCode, py: FileCode, rs: FileCode, go: FileCode, java: FileCode, rb: FileCode,
  c: FileCode, h: FileCode, cpp: FileCode, cs: FileCode, php: FileCode, swift: FileCode,
  html: FileCode, htm: FileCode,
  json: FileJson,
  md: FileText, mdx: FileText, txt: FileText, pdf: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage, webp: FileImage, ico: FileImage, avif: FileImage,
  css: FileType, scss: FileType, sass: FileType, less: FileType,
  yml: FileCog, yaml: FileCog, toml: FileCog, ini: FileCog, env: FileCog, conf: FileCog,
  lock: FileLock,
  sh: FileTerminal, bash: FileTerminal, zsh: FileTerminal, fish: FileTerminal,
  zip: FileArchive, tar: FileArchive, gz: FileArchive, tgz: FileArchive, rar: FileArchive, "7z": FileArchive,
};

/** Pick a lucide icon component for a filename, by extension (case-insensitive). */
export function iconForFile(name: string): Component {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return FileIcon;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_ICON[ext] ?? FileIcon;
}
