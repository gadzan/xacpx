import { expect, test, beforeEach } from "bun:test";
import { getHelpTopic, listHelpTopics } from "../../../../src/commands/help/help-registry";
import { setLocale } from "../../../../src/i18n";

beforeEach(() => {
  setLocale("zh");
});

test("listHelpTopics returns all registered help topics", () => {
  const topics = listHelpTopics();
  expect(topics.length).toBeGreaterThan(0);
  expect(topics.some((t) => t.topic === "session")).toBe(true);
  expect(topics.some((t) => t.topic === "workspace")).toBe(true);
  expect(topics.some((t) => t.topic === "agent")).toBe(true);
  expect(topics.some((t) => t.topic === "permission")).toBe(true);
  expect(topics.some((t) => t.topic === "later")).toBe(true);
});

test("getHelpTopic finds topic by exact name", () => {
  const topic = getHelpTopic("session");
  expect(topic).not.toBeNull();
  expect(topic?.topic).toBe("session");
});

test("getHelpTopic finds topic by alias", () => {
  const topic = getHelpTopic("ws");
  expect(topic).not.toBeNull();
  expect(topic?.topic).toBe("workspace");
});

test("getHelpTopic returns null for unknown topic", () => {
  const topic = getHelpTopic("nonexistent-topic");
  expect(topic).toBeNull();
});

test("getHelpTopic is case-sensitive", () => {
  const topic = getHelpTopic("Session");
  expect(topic).toBeNull();
});

test("each help topic has required fields", () => {
  const topics = listHelpTopics();
  for (const topic of topics) {
    expect(topic.topic).toBeDefined();
    expect(topic.summary).toBeDefined();
    expect(Array.isArray(topic.commands)).toBe(true);
    expect(topic.commands.length).toBeGreaterThan(0);
  }
});

test("help topics have valid command structures", () => {
  const topics = listHelpTopics();
  for (const topic of topics) {
    for (const command of topic.commands) {
      expect(command.usage).toBeDefined();
      expect(command.description).toBeDefined();
    }
  }
});

test("permission help topic has correct metadata", () => {
  const topic = getHelpTopic("permission");
  expect(topic).not.toBeNull();
  expect(topic?.aliases).toContain("pm");
});

test("later help topic has correct metadata", () => {
  const topic = getHelpTopic("later");
  expect(topic).not.toBeNull();
  expect(topic?.aliases).toContain("lt");
});