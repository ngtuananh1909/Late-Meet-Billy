/**
 * @fileoverview Export pipeline for generating the 3 meeting artifacts:
 * 1. Full Transcript (.md / .txt) with timestamps and speaker tags
 * 2. Video Recording (.webm) screen/tab capture with mixed audio
 * 3. AI Master Meeting Minutes (MoM) (.md) structured with decisions, action items, and summary.
 */

import { State, ExportArtifactsInfo } from "../types";
import { formatDuration } from "./domHelpers";
import { callChatCompletion, getAiGatewayConfig } from "./aiGateway";

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 50);
}

function formatDateForFilename(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}_${hour}${min}`;
}

/** Formats the complete sequential meeting transcript into structured Markdown. */
export function generateFullTranscriptMarkdown(state: State): string {
  const dateVal = state.savedAt || state.startTime || Date.now();
  const dateStr = new Date(dateVal).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const durationSec =
    state.duration || (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0);

  let md = `# Meeting Transcript — ${state.meetingId || "Meeting"}\n\n`;
  md += `- **Date:** ${dateStr}\n`;
  md += `- **Meeting ID:** \`${state.meetingId || "N/A"}\`\n`;
  md += `- **Duration:** ${formatDuration(durationSec)}\n`;
  md += `- **Participants:** ${state.participants?.length ? state.participants.join(", ") : "None detected"}\n\n`;
  md += `---\n\n## Sequential Transcript\n\n`;

  if (!state.transcript || state.transcript.length === 0) {
    md += `_No transcript recorded for this session._\n`;
    return md;
  }

  const baseTime = state.startTime || state.transcript[0].timestamp || Date.now();

  for (const entry of state.transcript) {
    const elapsed = Math.max(0, Math.floor((entry.timestamp - baseTime) / 1000));
    const label = entry.timestampLabel || formatDuration(elapsed);
    md += `**[${label}] ${entry.speaker}:** ${entry.text}\n\n`;
  }

  return md;
}

/** Prompts the Custom AI Gateway to generate a comprehensive Master Meeting Minutes (MoM) Markdown document. */
export async function generateMasterMoMMarkdown(state: State): Promise<string> {
  const gatewayConfig = await getAiGatewayConfig();
  const dateVal = state.savedAt || state.startTime || Date.now();
  const dateStr = new Date(dateVal).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const durationSec =
    state.duration || (state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0);

  // Compile chunk summaries and key points into context
  let contextInfo = `Meeting ID: ${state.meetingId || "N/A"}\nDate: ${dateStr}\nDuration: ${formatDuration(durationSec)}\nAttendees: ${(state.participants || []).join(", ") || "N/A"}\n\n`;

  if (state.chunkSummaries && state.chunkSummaries.length > 0) {
    contextInfo += `### Interim Chunk Summaries:\n`;
    state.chunkSummaries.forEach((chunk, i) => {
      contextInfo += `\n[Chunk ${i + 1} (${chunk.timeRangeLabel})]:\n${chunk.summary}\n`;
      if (chunk.decisions.length) {
        contextInfo += `Decisions: ${chunk.decisions.map((d) => d.text).join("; ")}\n`;
      }
      if (chunk.actionItems.length) {
        contextInfo += `Actions: ${chunk.actionItems.map((a) => a.task).join("; ")}\n`;
      }
    });
    contextInfo += `\n`;
  }

  // Also include the latest transcript lines if few chunks
  const sampleTranscript = (state.transcript || [])
    .slice(-100)
    .map((t) => `[${t.timestampLabel || ""}] ${t.speaker}: ${t.text}`)
    .join("\n");

  const langInstruction =
    gatewayConfig.language === "vi"
      ? "Viết toàn bộ nội dung Biên bản cuộc họp (MoM) bằng Tiếng Việt."
      : gatewayConfig.language === "en"
        ? "Write the entire Meeting Minutes (MoM) document in English."
        : "Write the Meeting Minutes (MoM) in the primary language spoken during the meeting (Vietnamese if meeting was in Vietnamese, English if in English).";

  const systemPrompt = `You are an elite Executive Meeting Secretary & Intelligence Engine.
Your objective is to produce a high-caliber, structured Master Meeting Minutes (MoM) document in Markdown (.md).

${langInstruction}

Strict Formatting Structure:
# 📋 Meeting Minutes: [Meeting Title or ID]
**Date:** [Date] | **Duration:** [HH:MM:SS]
**Attendees:** [List of Attendees]

---

## 📌 Executive Summary
[High-level overview: meeting objective, major topics discussed, overall outcomes]

## 🎯 Key Discussion Points
- **[Topic 1]**: [Details, rationale, consensus]
- **[Topic 2]**: [Details]

## ⚖️ Key Decisions Made
- [Decision 1] (Attributed to [Speaker] if known)
- [Decision 2]

## ✅ Action Items & Next Steps
- [ ] **[Task Description]** — Owner: @[Person] (Deadline: [Date/N/A])
- [ ] **[Task Description]** — Owner: @[Person]

## ❓ Open Questions & Follow-ups
- [Unresolved items, parked questions, or next meeting schedule]

Return ONLY the markdown document. Do not wrap in extra conversational greetings.`;

  const userPrompt = `Generate the Master Meeting Minutes (MoM) document based on this meeting context:

${contextInfo}

---
Recent Transcript Highlights:
${sampleTranscript || "(No transcript lines recorded)"}
`;

  try {
    const result = await callChatCompletion({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 2500,
    });

    let momContent = result.content.trim();
    // Clean potential markdown wrap ```markdown ... ```
    if (momContent.startsWith("```markdown")) {
      momContent = momContent.slice("```markdown".length);
    } else if (momContent.startsWith("```")) {
      momContent = momContent.slice(3);
    }
    if (momContent.endsWith("```")) {
      momContent = momContent.slice(0, -3);
    }
    return momContent.trim();
  } catch (err: any) {
    console.warn(
      "[LateMeet][export] AI MoM generation failed, generating local fallback MoM:",
      err,
    );

    // Fallback template if AI Gateway is unreachable
    let fallback = `# 📋 Meeting Minutes: ${state.meetingId || "Meeting"}\n\n`;
    fallback += `**Date:** ${dateStr} | **Duration:** ${formatDuration(durationSec)}\n`;
    fallback += `**Attendees:** ${(state.participants || []).join(", ") || "N/A"}\n\n---\n\n`;
    fallback += `## 📌 Summary\n${state.summary || "No automated summary available."}\n\n`;
    fallback += `## ⚖️ Key Decisions\n`;
    if (state.decisions?.length) {
      fallback +=
        state.decisions.map((d) => `- ${d.text}${d.by ? ` (${d.by})` : ""}`).join("\n") + "\n\n";
    } else {
      fallback += `_No decisions recorded_\n\n`;
    }
    fallback += `## ✅ Action Items\n`;
    if (state.actionItems?.length) {
      fallback +=
        state.actionItems
          .map((a) => `- [ ] ${a.task}${a.owner ? ` (@${a.owner})` : ""}`)
          .join("\n") + "\n\n";
    } else {
      fallback += `_No action items recorded_\n\n`;
    }
    return fallback;
  }
}

/** Triggers automatic downloads for the 3 artifacts via chrome.downloads. */
export async function downloadAllArtifacts(params: {
  state: State;
  videoUrl?: string | null;
  videoSizeBytes?: number;
}): Promise<ExportArtifactsInfo> {
  const { state, videoUrl, videoSizeBytes } = params;
  const now = Date.now();
  const slug = sanitizeFilename(state.meetingId || "Meeting");
  const timeStr = formatDateForFilename(state.startTime || now);

  const transcriptFilename = `${slug}_${timeStr}_Transcript.md`;
  const momFilename = `${slug}_${timeStr}_MoM.md`;
  const videoFilename = `${slug}_${timeStr}_Recording.webm`;

  // 1. Generate Full Transcript
  const transcriptMd = generateFullTranscriptMarkdown(state);
  const transcriptBlob = new Blob([transcriptMd], { type: "text/markdown;charset=utf-8" });
  const transcriptUrl = URL.createObjectURL(transcriptBlob);

  // 2. Generate Master MoM
  const momMarkdown = await generateMasterMoMMarkdown(state);
  const momBlob = new Blob([momMarkdown], { type: "text/markdown;charset=utf-8" });
  const momUrl = URL.createObjectURL(momBlob);

  // Trigger chrome.downloads for each artifact
  const downloadFile = (url: string, filename: string) => {
    return new Promise<number | undefined>((resolve) => {
      if (typeof chrome !== "undefined" && chrome.downloads) {
        chrome.downloads.download(
          {
            url,
            filename,
            saveAs: false,
          },
          (downloadId) => {
            if (chrome.runtime.lastError || !downloadId) {
              console.warn(
                `[LateMeet] chrome.downloads error for ${filename}:`,
                chrome.runtime.lastError?.message,
              );
              resolve(undefined);
              return;
            }

            if (!chrome.downloads.onChanged) {
              resolve(downloadId);
              return;
            }

            const listener = (delta: chrome.downloads.DownloadDelta) => {
              if (delta.id === downloadId && delta.state) {
                if (delta.state.current === "complete" || delta.state.current === "interrupted") {
                  try {
                    chrome.downloads.onChanged.removeListener(listener);
                  } catch {
                    // Ignore listener cleanup error
                  }
                  clearTimeout(timer);
                  resolve(downloadId);
                }
              }
            };

            const timer = setTimeout(() => {
              try {
                chrome.downloads.onChanged.removeListener(listener);
              } catch {
                // Ignore listener cleanup error
              }
              resolve(downloadId);
            }, 6000);

            chrome.downloads.onChanged.addListener(listener);
          },
        );
      } else {
        // Fallback for non-extension context
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        resolve(undefined);
      }
    });
  };

  try {
    await downloadFile(transcriptUrl, transcriptFilename);
  } catch (err) {
    console.warn("[LateMeet] Failed to auto-download transcript:", err);
  }

  try {
    await downloadFile(momUrl, momFilename);
  } catch (err) {
    console.warn("[LateMeet] Failed to auto-download MoM:", err);
  }

  if (videoUrl) {
    try {
      await downloadFile(videoUrl, videoFilename);
    } catch (err) {
      console.warn("[LateMeet] Failed to auto-download video recording:", err);
    }
  }

  const recordingSizeMb = videoSizeBytes
    ? Number((videoSizeBytes / (1024 * 1024)).toFixed(2))
    : undefined;

  const info: ExportArtifactsInfo = {
    transcriptFilename,
    transcriptUrl,
    recordingFilename: videoUrl ? videoFilename : undefined,
    recordingUrl: videoUrl || undefined,
    recordingSizeMb,
    momFilename,
    momUrl,
    momMarkdown,
    generatedAt: now,
  };

  return info;
}
