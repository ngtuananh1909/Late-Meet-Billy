import test from "node:test";
import assert from "node:assert/strict";
import { generateFullTranscriptMarkdown } from "../src/utils/exportArtifacts.ts";
import { State } from "../src/types.ts";

test("generateFullTranscriptMarkdown outputs structured markdown with speakers and timestamps", () => {
  const mockState: State = {
    isActive: false,
    meetingId: "abc-defg-hij",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    startTime: 1700000000000,
    summary: "Mock summary",
    topics: [],
    decisions: [],
    actionItems: [],
    currentTopic: "Kickoff",
    sentiment: "neutral",
    keyInsights: [],
    unresolvedDiscussions: [],
    contradictions: [],
    questionsRaised: [],
    participants: ["Alice", "Bob"],
    initialParticipants: ["Alice", "Bob"],
    lateJoiners: [],
    timeline: [],
    summaryItems: [],
    audioActive: false,
    transcript: [
      {
        speaker: "Alice",
        text: "Hello everyone, welcome to the kickoff.",
        timestamp: 1700000005000,
        timestampLabel: "00:05",
      },
      {
        speaker: "Bob",
        text: "Thanks Alice. Let's review the roadmap.",
        timestamp: 1700000020000,
        timestampLabel: "00:20",
      },
    ],
  };

  const md = generateFullTranscriptMarkdown(mockState);
  assert.ok(md.includes("# Meeting Transcript — abc-defg-hij"));
  assert.ok(md.includes("Alice, Bob"));
  assert.ok(md.includes("**[00:05] Alice:** Hello everyone, welcome to the kickoff."));
  assert.ok(md.includes("**[00:20] Bob:** Thanks Alice. Let's review the roadmap."));
});
