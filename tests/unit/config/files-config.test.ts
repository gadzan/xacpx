import { test, expect } from "bun:test";
import { filesWriteEnabled, type AppConfig } from "../../../src/config/types";

const base = {} as AppConfig; // helper only touches `.files`
test("filesWriteEnabled defaults to false when unset", () => {
  expect(filesWriteEnabled(base)).toBe(false);
});
test("filesWriteEnabled is true only when writeEnabled === true", () => {
  expect(filesWriteEnabled({ ...base, files: { writeEnabled: true } })).toBe(true);
  expect(filesWriteEnabled({ ...base, files: { writeEnabled: false } })).toBe(false);
});
