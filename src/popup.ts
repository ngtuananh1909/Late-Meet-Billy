import { State } from "./types";
import { initTheme } from "./theme.js";
import { getAiGatewayConfig, saveAiGatewayConfig, testGatewayConnection } from "./utils/aiGateway";
import { escapeHtml, formatDuration, sanitizeTopicStatus } from "./utils/domHelpers";
import { resolveManualMeetTab } from "./meetingTabs";
import { startPopupAudioCapture } from "./popupCapture";

initTheme();

const POPUP_ONBOARDING_TOUR_KEY = "popupOnboardingTourCompleted";

document.addEventListener("DOMContentLoaded", async () => {
  const setupView = document.getElementById("setup-view") as HTMLDivElement;
  const mainView = document.getElementById("main-view") as HTMLDivElement;
  const meetingSection = document.getElementById("meeting-section") as HTMLDivElement;
  const noMeetingSection = document.getElementById("no-meeting-section") as HTMLDivElement;
  const sessionModal = document.getElementById("session-modal") as HTMLDivElement;
  const sessionModalError = document.getElementById(
    "session-modal-error",
  ) as HTMLParagraphElement | null;

  let lastState: State | null = null;

  // ——— AI Gateway Setup Management ———
  const baseUrlInput = document.getElementById("gateway-base-url") as HTMLInputElement | null;
  const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement | null;
  const modelInput = document.getElementById("gateway-model-input") as HTMLInputElement | null;
  const langSelect = document.getElementById("gateway-lang-select") as HTMLSelectElement | null;
  const testStatus = document.getElementById("gateway-test-status") as HTMLDivElement | null;
  const testBtn = document.getElementById("test-gateway-btn") as HTMLButtonElement | null;
  const saveBtn = document.getElementById("save-keys") as HTMLButtonElement | null;

  // Load gateway config
  const gatewayConfig = await getAiGatewayConfig();
  if (baseUrlInput) baseUrlInput.value = gatewayConfig.baseURL || "http://localhost:4981/openai/v1";
  if (apiKeyInput) apiKeyInput.value = gatewayConfig.apiKey || "";
  if (modelInput) modelInput.value = gatewayConfig.modelName || "gemini-3.6-flash";
  if (langSelect) langSelect.value = gatewayConfig.language || "auto";

  // Check if gateway is ready (has baseURL and either apiKey or is local proxy)
  const isGatewayReady = Boolean(
    gatewayConfig.baseURL &&
    (gatewayConfig.apiKey ||
      gatewayConfig.baseURL.includes("localhost") ||
      gatewayConfig.baseURL.includes("127.0.0.1") ||
      gatewayConfig.baseURL.includes("0.0.0.0")),
  );

  if (isGatewayReady) {
    setupView.style.display = "none";
    mainView.style.display = "block";
  } else {
    setupView.style.display = "block";
    mainView.style.display = "none";
  }

  void maybeStartPopupTour();

  // Test gateway connection
  testBtn?.addEventListener("click", async () => {
    if (!testStatus) return;
    testStatus.className = "status-text";
    testStatus.style.color = "var(--text-sub, #a1a1aa)";
    testStatus.textContent = "⚡ Testing connection to gateway...";
    testBtn.disabled = true;

    const result = await testGatewayConnection({
      baseURL: baseUrlInput?.value.trim() || undefined,
      apiKey: apiKeyInput?.value.trim() || undefined,
      modelName: modelInput?.value.trim() || undefined,
    });

    testBtn.disabled = false;
    if (result.success) {
      testStatus.style.color = "#10b981";
      testStatus.textContent = `✅ Connected! Model: ${result.modelUsed} (${result.latencyMs}ms)`;
    } else {
      testStatus.style.color = "#ef4444";
      testStatus.textContent = `❌ ${result.error || "Connection failed"}`;
    }
  });

  // Save gateway config
  saveBtn?.addEventListener("click", async () => {
    const baseURL = baseUrlInput?.value.trim() || "http://localhost:4981/openai/v1";
    const apiKey = apiKeyInput?.value.trim() || "";
    const modelName = modelInput?.value.trim() || "gemini-3.6-flash";
    const language = (langSelect?.value as any) || "auto";

    if (!baseURL) {
      shakeElement(baseUrlInput);
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    await saveAiGatewayConfig({
      baseURL,
      apiKey,
      modelName,
      language,
    });

    saveBtn.disabled = false;
    saveBtn.innerHTML = `<span>Save & Continue</span><span class="btn-icon">→</span>`;

    setupView.style.display = "none";
    mainView.style.display = "block";
    void maybeStartPopupTour();
  });

  // Toggle API Key visibility
  document.getElementById("toggle-key")?.addEventListener("click", () => {
    if (apiKeyInput) {
      apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    }
  });

  // Full options page link
  document.getElementById("popup-open-options-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Settings button
  document.getElementById("settings-btn")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Open Side Panel buttons
  const openSidePanel = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.sidePanel.open({ tabId: tab.id });
      } else {
        await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      }
      window.close();
    } catch {
      chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch(() => {});
    }
  };

  document.getElementById("open-sidepanel-btn")?.addEventListener("click", openSidePanel);
  document.getElementById("open-dashboard")?.addEventListener("click", openSidePanel);

  // ——— Start Copilot (Audio Capture with User Gesture) ———
  const copilotBtn = document.getElementById("start-copilot-btn") as HTMLButtonElement | null;

  async function maybeStartPopupTour() {
    const stored = await chrome.storage.local.get(POPUP_ONBOARDING_TOUR_KEY);
    if (stored[POPUP_ONBOARDING_TOUR_KEY] || mainView.style.display === "none") return;
    globalThis.setTimeout(() => showPopupTourStep(0), 150);
  }

  async function completePopupTour() {
    clearPopupTour();
    await chrome.storage.local.set({ [POPUP_ONBOARDING_TOUR_KEY]: true });
  }

  function clearPopupTour() {
    document.querySelector(".tour-highlight")?.classList.remove("tour-highlight");
    document.getElementById("popup-tour-card")?.remove();
  }

  function showPopupTourStep(stepIndex: number) {
    const steps = [
      {
        selector: "#settings-btn",
        title: "Configure API keys",
        body: "Open Settings to add or update API keys before your first meeting.",
        placement: "top",
      },
      {
        selector: "#start-copilot-btn",
        title: "Start Copilot",
        body: "Join a Google Meet, then use Start Copilot to begin audio capture and live summaries.",
        placement: "bottom",
      },
    ];
    const step = steps[stepIndex];
    if (!step) {
      void completePopupTour();
      return;
    }

    clearPopupTour();
    const target = document.querySelector(step.selector) as HTMLElement | null;
    if (target?.offsetParent == null) {
      showPopupTourStep(stepIndex + 1);
      return;
    }

    target.classList.add("tour-highlight");
    const card = document.createElement("div");
    card.id = "popup-tour-card";
    card.className = `popup-tour-card popup-tour-card--${step.placement}`;
    card.innerHTML = `
      <div class="popup-tour-kicker">Quick guide ${stepIndex + 1}/${steps.length}</div>
      <h3>${escapeHtml(step.title)}</h3>
      <p>${escapeHtml(step.body)}</p>
      <div class="popup-tour-actions">
        <button type="button" class="popup-tour-skip">Skip</button>
        <button type="button" class="popup-tour-next">${stepIndex === steps.length - 1 ? "Done" : "Next"}</button>
      </div>
    `;
    document.body.appendChild(card);

    const targetRect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const top =
      step.placement === "top"
        ? Math.max(12, targetRect.bottom + 10)
        : Math.max(12, targetRect.top - cardRect.height - 10);
    const left = Math.min(
      Math.max(12, targetRect.left + targetRect.width / 2 - cardRect.width / 2),
      globalThis.innerWidth - cardRect.width - 12,
    );
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;

    card
      .querySelector(".popup-tour-skip")
      ?.addEventListener("click", () => void completePopupTour());
    card
      .querySelector(".popup-tour-next")
      ?.addEventListener("click", () => showPopupTourStep(stepIndex + 1));
  }

  function getPopupMediaStreamId(tabId: number): Promise<string> {
    return new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Unknown tab capture error"));
          return;
        }

        resolve(streamId || "");
      });
    });
  }

  async function requestPopupMicrophonePermission(): Promise<boolean> {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream.getTracks().forEach((track) => track.stop());
      return true;
    } catch {
      console.warn("[LateMeet] Microphone permission not granted — recording tab audio only");
      return false;
    }
  }

  async function handleStopAudio(btn?: HTMLButtonElement | null) {
    if (!lastState?.audioActive) return;

    try {
      if (btn) btn.disabled = true;
      await chrome.runtime.sendMessage({ type: "MANUAL_STOP_AUDIO" });
    } catch (err) {
      console.error("[LateMeet] Failed to stop audio:", err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleStartAudio(btn: HTMLButtonElement) {
    const textEl = btn.querySelector(".copilot-btn-text");
    const originalText = textEl?.textContent || "Start Meeting";

    // --- Pre-flight Check for AI Gateway ---
    const gateway = await getAiGatewayConfig();
    if (!gateway.baseURL) {
      alert("Please configure your AI Gateway settings before starting.");
      chrome.runtime.openOptionsPage();
      return;
    }

    if (lastState?.audioActive) {
      console.log("[LateMeet] Audio already active, skipping capture request.");
      return;
    }

    try {
      // Show loading state
      btn.disabled = true;
      if (textEl) textEl.textContent = "Starting...";
      btn.classList.add("loading");

      const { meetingId, microphoneEnabled } = await startPopupAudioCapture({
        resolveMeetTab: resolveManualMeetTab,
        getMediaStreamId: getPopupMediaStreamId,
        requestMicrophonePermission: requestPopupMicrophonePermission,
        startAudioCapture: (payload) =>
          chrome.runtime.sendMessage({
            type: "MANUAL_START_AUDIO",
            ...payload,
          }),
      });

      if (!microphoneEnabled) {
        console.warn("[LateMeet] Started without microphone input — tab audio only");
      }

      // Clear loading state before setting active state
      btn.disabled = false;
      btn.classList.remove("loading");
      setCopilotActive(true);
      // Immediately show meeting section and start timer
      if (meetingSection) meetingSection.style.display = "block";
      if (noMeetingSection) noMeetingSection.style.display = "none";
      if (meetingId) {
        const meetingIdEl = document.getElementById("meeting-id");
        if (meetingIdEl) meetingIdEl.textContent = meetingId;
      }
      const badge = document.getElementById("status-badge");
      if (badge) {
        badge.className = "status-badge active";
        const statusText = badge.querySelector(".status-text");
        if (statusText) statusText.textContent = "Recording...";
      }
      startDurationTimer(Date.now());
    } catch (err: any) {
      if ((err.message || "").includes("active stream")) {
        setCopilotActive(true);
        return;
      }

      handleStartAudioError(err);
    }

    function handleStartAudioError(err: any) {
      console.error("Failed to start audio capture:", err);
      btn.disabled = false;
      btn.classList.remove("loading");
      if (textEl) {
        textEl.textContent =
          err.message?.length > 40 ? "Error — Check Console" : err.message || "Unknown error";
        setTimeout(() => {
          if (textEl) textEl.textContent = originalText;
        }, 3000);
      }
    }
  }

  copilotBtn?.addEventListener("click", () => {
    if (lastState?.audioActive) {
      handleStopAudio(copilotBtn);
      return;
    }
    handleStartAudio(copilotBtn);
  });

  document.getElementById("meeting-start-audio-btn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget as HTMLButtonElement | null;
    if (!btn) return;
    if (lastState?.audioActive) {
      handleStopAudio(btn);
      return;
    }
    handleStartAudio(btn);
  });

  function setCopilotActive(active: boolean) {
    if (!copilotBtn) return;
    const miniBtn = document.getElementById("meeting-start-audio-btn");
    const iconEl = copilotBtn.querySelector(".copilot-btn-icon");
    const textEl = copilotBtn.querySelector(".copilot-btn-text");

    const getMiniBtnLabelNode = () => {
      if (!miniBtn) return null;
      return (
        Array.from(miniBtn.childNodes)
          .reverse()
          .find((n) => n.nodeType === Node.TEXT_NODE && String(n.textContent || "").trim()) || null
      );
    };

    if (active) {
      copilotBtn.classList.remove("loading");
      copilotBtn.classList.add("active");
      if (textEl) textEl.textContent = "End Meeting";
      if (iconEl) {
        iconEl.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
      }
      copilotBtn.disabled = false;
      copilotBtn.title = "End Meeting & Generate MoM";

      if (miniBtn) {
        miniBtn.style.display = "flex";
        miniBtn.classList.add("active");
        miniBtn.title = "End Meeting & Generate MoM";
        const labelNode = getMiniBtnLabelNode();
        if (labelNode) labelNode.textContent = " End Meeting";
      }
    } else {
      copilotBtn.classList.remove("active");
      if (textEl) textEl.textContent = "Start Meeting";
      if (iconEl) {
        iconEl.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
      }
      copilotBtn.disabled = false;
      copilotBtn.title = "Start Meeting";

      if (miniBtn) {
        miniBtn.style.display = "flex";
        miniBtn.classList.remove("active");
        miniBtn.title = "Start Meeting";
        const labelNode = getMiniBtnLabelNode();
        if (labelNode) labelNode.textContent = " Start Meeting";
      }
    }
  }

  // ——— Session Save/Discard Modal ———
  let previouslyFocusedElement: HTMLElement | null = null;

  function trapFocus(e: KeyboardEvent) {
    if (e.key !== "Tab") return;
    const focusableEls = sessionModal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusableEls.length === 0) return;
    const firstEl = focusableEls[0];
    const lastEl = focusableEls[focusableEls.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      }
    } else {
      if (document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  }

  function handleModalKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      hideSessionModal();
    }
    trapFocus(e);
  }

  function showSessionModal() {
    const saveBtn = document.getElementById("save-session-btn") as HTMLButtonElement | null;
    const discardBtn = document.getElementById("discard-session-btn") as HTMLButtonElement | null;
    if (sessionModalError) {
      sessionModalError.hidden = true;
      sessionModalError.textContent = "";
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Session";
      saveBtn.classList.remove("loading");
    }
    if (discardBtn) {
      discardBtn.disabled = false;
      discardBtn.textContent = "Discard";
      discardBtn.classList.remove("loading");
    }
    previouslyFocusedElement = document.activeElement as HTMLElement | null;
    sessionModal.style.display = "flex";
    requestAnimationFrame(() => {
      sessionModal.classList.add("visible");
      // Move focus into the modal
      (saveBtn || discardBtn)?.focus();
    });
    sessionModal.addEventListener("keydown", handleModalKeydown);
  }

  function hideSessionModal() {
    sessionModal.classList.remove("visible");
    sessionModal.removeEventListener("keydown", handleModalKeydown);
    setTimeout(() => {
      sessionModal.style.display = "none";
      // Return focus to the previously focused element
      previouslyFocusedElement?.focus();
      previouslyFocusedElement = null;
    }, 300);
  }

  // Backdrop click to dismiss
  sessionModal.querySelector(".session-modal-backdrop")?.addEventListener("click", () => {
    hideSessionModal();
  });

  document.getElementById("save-session-btn")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const discardBtn = document.getElementById("discard-session-btn") as HTMLButtonElement | null;
    const originalText = btn.textContent || "Save Session";

    btn.disabled = true;
    btn.textContent = "Saving...";
    btn.classList.add("loading");
    if (sessionModalError) {
      sessionModalError.hidden = true;
      sessionModalError.textContent = "";
    }
    if (discardBtn) {
      discardBtn.disabled = true;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: "SAVE_SESSION" });
      if (!response?.success) {
        throw new Error(response?.error || "Failed to save session");
      }
      hideSessionModal();
    } catch (err) {
      console.error("[LateMeet] Failed to save session:", err);
      if (sessionModalError) {
        sessionModalError.hidden = false;
        sessionModalError.textContent =
          err instanceof Error
            ? err.message
            : "Unable to save this session. Export it from the dashboard before closing Chrome.";
      }
      // Restore states on error
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove("loading");
      if (discardBtn) {
        discardBtn.disabled = false;
      }
    }
  });

  document.getElementById("discard-session-btn")?.addEventListener("click", async (e) => {
    if (
      !confirm(
        "Are you sure you want to discard this session? All meeting intelligence will be permanently lost.",
      )
    ) {
      return;
    }
    const btn = e.currentTarget as HTMLButtonElement;
    const saveBtn = document.getElementById("save-session-btn") as HTMLButtonElement | null;
    const originalText = btn.textContent || "Discard";

    btn.disabled = true;
    btn.textContent = "Discarding...";
    btn.classList.add("loading");
    if (saveBtn) {
      saveBtn.disabled = true;
    }

    try {
      const response = await chrome.runtime.sendMessage({ type: "DISCARD_SESSION" });
      if (!response?.success) {
        throw new Error(response?.error || "Failed to discard session");
      }
      hideSessionModal();
    } catch (err) {
      console.error("[LateMeet] Failed to discard session:", err);
      // Restore states on error
      btn.disabled = false;
      btn.textContent = originalText;
      btn.classList.remove("loading");
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }
  });

  // ——— Check for pending session on load ———
  const { pendingSession } = (await chrome.storage.local.get("pendingSession")) as {
    pendingSession?: State;
  };
  if (pendingSession && !pendingSession.isActive) {
    showSessionModal();
  }

  // ——— Get Initial state load ———
  try {
    lastState = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (lastState) updateUI(lastState);
  } catch {
    /* background script might be idle */
  }

  // ——— Listen for State Updates ———
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "STATE_UPDATE") {
      lastState = message.state;
      updateUI(message.state);
    }
    if (message.type === "SESSION_ENDED") {
      showSessionModal();
    }
  });

  // ——— Duration Timer ———
  let durationInterval: number | NodeJS.Timeout | null = null;

  function startDurationTimer(startTime: number) {
    if (durationInterval) return;

    durationInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const timerEl = document.getElementById("meeting-duration");
      if (timerEl) timerEl.textContent = formatDuration(elapsed);
    }, 1000);
  }

  // ——— Update UI ———
  function updateUI(state: State) {
    if (state.isActive) {
      if (meetingSection) meetingSection.style.display = "block";
      if (noMeetingSection) noMeetingSection.style.display = "none";

      const badge = document.getElementById("status-badge");
      if (badge) {
        badge.className = "status-badge active";
        const statusText = badge.querySelector(".status-text");
        if (statusText)
          statusText.textContent = state.audioActive ? "Recording..." : "Meeting active";
      }

      const meetingIdEl = document.getElementById("meeting-id");
      if (meetingIdEl) meetingIdEl.textContent = state.meetingId || "—";

      if (state.startTime) startDurationTimer(state.startTime);

      const summaryEl = document.getElementById("summary-text");
      if (summaryEl) summaryEl.textContent = state.summary || "Waiting for conversation...";

      const topicEl = document.getElementById("current-topic");
      if (topicEl) topicEl.textContent = state.currentTopic || "Detecting...";

      const participantsCountEl = document.getElementById("participant-count");
      if (participantsCountEl)
        participantsCountEl.textContent = String(state.participants?.length || 0);

      const decisionCountEl = document.getElementById("decision-count");
      if (decisionCountEl) decisionCountEl.textContent = String(state.decisions?.length || 0);

      const actionCountEl = document.getElementById("action-count");
      if (actionCountEl) actionCountEl.textContent = String(state.actionItems?.length || 0);

      const sentimentEl = document.getElementById("sentiment-icon");
      if (sentimentEl) sentimentEl.textContent = getSentimentEmoji(state.sentiment);

      setCopilotActive(state.audioActive || false);

      const topicsList = document.getElementById("topics-list");
      if (topicsList) {
        if (state.topics && state.topics.length > 0) {
          topicsList.innerHTML =
            `<ul class="topics-items-list">` +
            state.topics
              .map(
                (t) => `
            <li class="topic-item">
              <div class="topic-dot ${sanitizeTopicStatus(t.status)}"></div>
              <span class="topic-name">${escapeHtml(t.name || "")}</span>
              <span class="topic-status ${sanitizeTopicStatus(t.status)}">${escapeHtml(t.status || "active")}</span>
            </li>
          `,
              )
              .join("") +
            `</ul>`;
        } else {
          topicsList.innerHTML = '<div class="empty-state">No topics detected yet</div>';
        }
      }

      const lateSection = document.getElementById("late-joiners-section");
      const lateList = document.getElementById("late-joiners-list");
      if (lateSection && lateList) {
        if (state.lateJoiners && state.lateJoiners.length > 0) {
          lateSection.style.display = "block";
          lateList.innerHTML = state.lateJoiners
            .map(
              (name) => `
            <div class="late-joiner-item">
              <span class="joiner-icon">🚪</span>
              <span class="joiner-name">${escapeHtml(name || "")}</span>
              <span style="color: var(--text-muted); font-size: 10px;">briefed ✓</span>
            </div>
          `,
            )
            .join("");
        } else {
          lateSection.style.display = "none";
          lateList.innerHTML = "";
        }
      }
    } else {
      if (meetingSection) meetingSection.style.display = "none";
      if (noMeetingSection) noMeetingSection.style.display = "block";

      const badge = document.getElementById("status-badge");
      if (badge) {
        badge.className = "status-badge inactive";
        const statusText = badge.querySelector(".status-text");
        if (statusText) statusText.textContent = "No active meeting";
      }

      if (durationInterval) {
        clearInterval(durationInterval as any);
        durationInterval = null;
      }
    }
  }

  // ——— Helpers ———
  function getSentimentEmoji(sentiment: string) {
    const map: Record<string, string> = {
      positive: "😊",
      negative: "😟",
      neutral: "😐",
      mixed: "🤔",
    };
    return map[sentiment] || "—";
  }

  function shakeElement(el: HTMLElement | null) {
    if (!el) return;
    el.classList.add("shake", "border-danger");
    setTimeout(() => {
      el.classList.remove("shake", "border-danger");
    }, 400);
  }

  // ——— Cleanup on popup close ———
  globalThis.addEventListener("unload", () => {
    if (durationInterval) {
      clearInterval(durationInterval as number);
      durationInterval = null;
    }
  });
});
