/**
 * @fileoverview Google Meet DOM Closed Caption Scraper.
 * Monitors Google Meet live captions via MutationObserver, extracts speaker attribution
 * and streaming text, debounces utterances, and sends finalized transcript entries to background.
 */

import { TranscriptEntry } from "./types";
import { formatDuration } from "./utils/domHelpers";

export type TranscriptCallback = (entry: TranscriptEntry) => void;

interface CaptionState {
  speaker: string;
  text: string;
  startTime: number;
  lastUpdated: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEBOUNCE_FLUSH_MS = 1400; // Time of silence after which a caption line is committed

let observer: MutationObserver | null = null;
let currentCaptionState: CaptionState | null = null;
let activeCallback: TranscriptCallback | null = null;
let meetingStartTime = Date.now();

// Selectors for Google Meet closed captions containers and elements (covering standard & localized UI)
const CAPTION_SELECTORS = {
  // Main caption regions
  containers: [
    'div[jscontroller="D1tHje"]',
    "div.a4cQT",
    'div[jsname="ds3Trf"]',
    'div[role="region"][aria-label*="caption" i]',
    'div[role="region"][aria-label*="phụ đề" i]',
  ],
  // Speaker name element inside a caption block
  speaker: [
    "div.zs75Ib",
    "span.NWkfZe",
    'div[class*="TBMuR"]',
    'div[class*="jT30ne"]',
    "[data-self-name]",
  ],
  // Caption text element inside a caption block
  text: ["div.iTTPOb", "span.VbkSUe", 'div[class*="yg7Twc"]', 'span[class*="CNusmb"]'],
  // CC Toggle button in Meet controls
  ccButtons: [
    'button[aria-label*="caption" i]',
    'button[data-tooltip*="caption" i]',
    'button[aria-label*="phụ đề" i]',
    'button[data-tooltip*="phụ đề" i]',
    'button[jsname][aria-label*="Captions" i]',
  ],
};

/** Checks if Google Meet closed captions are currently enabled in the UI. */
export function isMeetCaptionsEnabled(): boolean {
  for (const selector of CAPTION_SELECTORS.ccButtons) {
    const btn = document.querySelector(selector) as HTMLElement | null;
    if (btn) {
      const ariaPressed = btn.getAttribute("aria-pressed");
      const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
      if (
        ariaPressed === "true" ||
        ariaLabel.includes("turn off") ||
        ariaLabel.includes("tắt phụ đề")
      ) {
        return true;
      }
    }
  }

  // Also check if any caption container exists with content
  for (const selector of CAPTION_SELECTORS.containers) {
    const container = document.querySelector(selector);
    if (container && container.childNodes.length > 0) return true;
  }

  return false;
}

/** Attempts to turn on Google Meet captions if currently off. */
export function ensureMeetCaptionsActive(): boolean {
  if (isMeetCaptionsEnabled()) return true;

  // Try clicking the CC button
  for (const selector of CAPTION_SELECTORS.ccButtons) {
    const btn = document.querySelector(selector) as HTMLElement | null;
    if (btn) {
      btn.click();
      console.log("[LateMeet][Captions] Clicked CC toggle button to enable captions.");
      return true;
    }
  }

  // Fallback: Dispatch 'c' keydown shortcut to Google Meet window
  try {
    const keyEvent = new KeyboardEvent("keydown", {
      key: "c",
      code: "KeyC",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(keyEvent);
    console.log("[LateMeet][Captions] Dispatched 'c' key shortcut to toggle captions.");
    return true;
  } catch (err) {
    console.warn("[LateMeet][Captions] Failed to trigger CC toggle shortcut:", err);
    return false;
  }
}

/** Flushes and commits the active buffered caption state into a finalized TranscriptEntry. */
function flushActiveCaption() {
  if (!currentCaptionState) return;

  const { speaker, text, startTime } = currentCaptionState;
  if (currentCaptionState.timer) {
    clearTimeout(currentCaptionState.timer);
    currentCaptionState.timer = null;
  }
  currentCaptionState = null;

  const cleanedText = text.trim();
  if (!cleanedText) return;

  const elapsedSec = Math.max(0, Math.round((startTime - meetingStartTime) / 1000));
  const entry: TranscriptEntry = {
    id: `dom-${startTime}-${Math.random().toString(36).slice(2, 7)}`,
    speaker: speaker || "Unknown",
    text: cleanedText,
    timestamp: startTime,
    timestampLabel: formatDuration(elapsedSec),
  };

  console.log(
    `[LateMeet][Captions] Committed: [${entry.timestampLabel}] ${entry.speaker}: ${entry.text}`,
  );

  if (activeCallback) {
    activeCallback(entry);
  }

  chrome.runtime
    .sendMessage({
      type: "DOM_TRANSCRIPT_ENTRY",
      entry,
    })
    .catch(() => {});
}

/** Extracts speaker name from a caption node or surrounding elements. */
function extractSpeakerFromNode(node: Element): string {
  for (const selector of CAPTION_SELECTORS.speaker) {
    const el = node.querySelector(selector);
    if (el && el.textContent?.trim()) {
      return el.textContent.trim();
    }
  }

  // Check parent or previous sibling for speaker container
  const parent = node.closest('.a4cQT, [jscontroller="D1tHje"], div[class*="TBMuR"]');
  if (parent) {
    for (const selector of CAPTION_SELECTORS.speaker) {
      const el = parent.querySelector(selector);
      if (el && el.textContent?.trim()) {
        return el.textContent.trim();
      }
    }
  }

  // If node itself has aria-label with speaker name
  const aria = node.getAttribute("aria-label");
  if (aria && !aria.toLowerCase().includes("caption")) {
    return aria.trim();
  }

  return currentCaptionState?.speaker || "Speaker";
}

/** Extracts current full text from a caption block node. */
function extractTextFromNode(node: Element): string {
  for (const selector of CAPTION_SELECTORS.text) {
    const el = node.querySelector(selector);
    if (el && el.textContent?.trim()) {
      return el.textContent.trim();
    }
  }
  return node.textContent?.trim() || "";
}

/** Handles a detected mutation inside the Google Meet captions DOM tree. */
function handleCaptionMutation(mutations: MutationRecord[]) {
  for (const mutation of mutations) {
    const target = mutation.target as HTMLElement;
    if (!target) continue;

    // Find the closest caption block or element
    const block =
      target.closest(
        'div.iTTPOb, span.VbkSUe, div.a4cQT, div[jscontroller="D1tHje"], [class*="yg7Twc"]',
      ) || target;

    const speaker = extractSpeakerFromNode(block);
    const text = extractTextFromNode(block);

    if (!text) continue;

    const now = Date.now();

    // If speaker changed from current buffer, flush previous speaker immediately
    if (
      currentCaptionState &&
      currentCaptionState.speaker !== speaker &&
      currentCaptionState.text.trim()
    ) {
      flushActiveCaption();
    }

    if (!currentCaptionState) {
      currentCaptionState = {
        speaker,
        text,
        startTime: now,
        lastUpdated: now,
        timer: null,
      };
    } else {
      currentCaptionState.text = text;
      currentCaptionState.lastUpdated = now;
      if (currentCaptionState.timer) {
        clearTimeout(currentCaptionState.timer);
      }
    }

    // Schedule debounce flush
    currentCaptionState.timer = setTimeout(() => {
      flushActiveCaption();
    }, DEBOUNCE_FLUSH_MS);
  }
}

/** Starts monitoring Google Meet captions. */
export function startCaptionObserver(
  callback?: TranscriptCallback,
  sessionStartTime?: number,
): void {
  stopCaptionObserver();

  if (sessionStartTime) {
    meetingStartTime = sessionStartTime;
  } else {
    meetingStartTime = Date.now();
  }

  activeCallback = callback || null;

  // Try auto-enabling CC if not already on
  ensureMeetCaptionsActive();

  observer = new MutationObserver((mutations) => {
    handleCaptionMutation(mutations);
  });

  // Observe entire body with subtree to reliably catch newly attached caption regions
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  console.log("[LateMeet][Captions] DOM Caption observer started successfully.");
}

/** Stops monitoring Google Meet captions and flushes any pending buffer. */
export function stopCaptionObserver(): void {
  if (currentCaptionState) {
    flushActiveCaption();
  }

  if (observer) {
    observer.disconnect();
    observer = null;
    console.log("[LateMeet][Captions] DOM Caption observer disconnected.");
  }

  activeCallback = null;
}
