import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, DEFAULT_BASE_URL } from "../src/utils/aiGateway.ts";

test("normalizeBaseUrl handles empty or null input with default URL", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl("   "), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(null), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL);
});

test("normalizeBaseUrl strips trailing slashes", () => {
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  assert.equal(normalizeBaseUrl("http://localhost:11434/v1///"), "http://localhost:11434/v1");
});

test("normalizeBaseUrl strips accidental /chat/completions suffix", () => {
  assert.equal(
    normalizeBaseUrl("https://openrouter.ai/api/v1/chat/completions"),
    "https://openrouter.ai/api/v1",
  );
  assert.equal(
    normalizeBaseUrl("http://localhost:11434/v1/chat/completions/"),
    "http://localhost:11434/v1",
  );
});
