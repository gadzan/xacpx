import { timingSafeEqual } from "node:crypto";

import { isLoopbackHost } from "./config.js";

export function tokensMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function allowedHostNames(bindHost: string): string[] {
  const names = new Set<string>([bindHost.trim().toLowerCase()]);
  if (isLoopbackHost(bindHost)) {
    names.add("127.0.0.1");
    names.add("localhost");
    names.add("[::1]");
  }
  return [...names];
}

function hostWithPort(name: string, port: number): string[] {
  const withPort = `${name}:${port}`;
  if (port === 80 || port === 443) return [withPort, name];
  return [withPort];
}

export function hostHeaderAllowed(hostHeader: string | undefined, bindHost: string, port: number): boolean {
  if (!hostHeader) return false;
  const value = hostHeader.trim().toLowerCase();
  return allowedHostNames(bindHost).some((name) => hostWithPort(name, port).includes(value));
}

export function originAllowed(origin: string | undefined, bindHost: string, port: number): boolean {
  if (origin === undefined || origin === "") return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const names = new Set(allowedHostNames(bindHost));
  const statedPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return names.has(parsed.hostname.toLowerCase()) && statedPort === String(port);
}

export function jsonContentType(header: string | undefined): boolean {
  if (!header) return false;
  return header.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}
