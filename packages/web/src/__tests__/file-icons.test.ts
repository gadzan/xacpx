import { describe, it, expect } from "vitest";
import { FileCode, FileJson, FileImage, File as FileIcon } from "lucide-vue-next";
import { iconForFile } from "../lib/file-icons";

describe("iconForFile", () => {
  it("maps known extensions", () => {
    expect(iconForFile("main.ts")).toBe(FileCode);
    expect(iconForFile("data.json")).toBe(FileJson);
    expect(iconForFile("logo.svg")).toBe(FileImage);
    expect(iconForFile("photo.PNG")).toBe(FileImage); // case-insensitive
  });
  it("falls back to a generic file icon", () => {
    expect(iconForFile("mystery.xyz")).toBe(FileIcon);
    expect(iconForFile("noext")).toBe(FileIcon);
  });
});
