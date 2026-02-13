/**
 * popup.js – LinkedIn Bulk Resume Downloader
 * Controls the popup UI, communicates with content script & background worker.
 */

// ── DOM Elements ───────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const btnStart        = $("btnStart");
const btnStop         = $("btnStop");
const statusDot       = $("statusDot");
const statusText      = $("statusText");
const foundCount      = $("foundCount");
const downloadedCount = $("downloadedCount");
const failedCount     = $("failedCount");
const progressLabel   = $("progressLabel");
const progressPercent = $("progressPercent");
const progressBarFill = $("progressBarFill");
const logArea         = $("logArea");

// ── State ──────────────────────────────────────────────────
let isRunning = false;
let currentTabId = null;

// ── Helpers ────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = "status-dot " + state;
  statusText.textContent = text;
}

function updateProgress(downloaded, total, failed = 0) {
  const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
  foundCount.textContent      = total;
  downloadedCount.textContent = downloaded;
  failedCount.textContent     = failed;
  progressLabel.textContent   = `Downloaded ${downloaded} of ${total}`;
  progressPercent.textContent = `${pct}%`;
  progressBarFill.style.width = `${pct}%`;
}

function addLog(message, type = "info") {
  const entry = document.createElement("div");
  entry.className = "log-entry " + type;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${message}`;
  logArea.prepend(entry);
}

// ── Initialisation — check active tab ─────────────────────

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setStatus("error", "No active tab found");
      return;
    }

    currentTabId = tab.id;
    const url = tab.url || "";

    // Safety: only run on LinkedIn hiring / jobs pages
    const isLinkedInPage =
      url.includes("linkedin.com/hiring") ||
      url.includes("linkedin.com/talent") ||
      url.includes("linkedin.com/jobs");

    if (!isLinkedInPage) {
      setStatus("error", "Not a LinkedIn Hiring / Jobs page");
      btnStart.textContent = "❌ Wrong Page";
      btnStart.disabled = true;
      addLog("Navigate to a LinkedIn hiring/jobs page first.", "error");
      return;
    }

    // Inject content script if not already present (handles pages that
    // were open before the extension was installed)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTabId },
        files: ["content.js"],
      });
    } catch (_) {
      // content script already injected or duplicate injection — safe to ignore
    }

    // Ask content script to scan for resume download buttons
    setStatus("scanning", "Scanning page for resumes…");
    btnStart.textContent = "⏳ Scanning…";

    chrome.tabs.sendMessage(currentTabId, { action: "SCAN_RESUMES" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        setStatus("error", "Cannot communicate with page — try refreshing");
        btnStart.textContent = "🔄 Refresh Page";
        btnStart.disabled = true;
        addLog("Content script not responding. Refresh the LinkedIn page.", "error");
        return;
      }

      const count = response.count || 0;
      updateProgress(0, count);

      if (count === 0) {
        setStatus("idle", "No downloadable resumes found on this page");
        btnStart.textContent = "No Resumes Found";
        btnStart.disabled = true;
        addLog("0 resume download buttons detected.", "error");
      } else {
        setStatus("idle", `Found ${count} resume(s) ready to download`);
        btnStart.textContent = `▶ Start Bulk Download (${count})`;
        btnStart.disabled = false;
        addLog(`Scan complete — ${count} resume(s) detected.`, "success");
      }
    });
  } catch (err) {
    setStatus("error", "Initialisation error");
    addLog(err.message, "error");
  }
}

// ── Start Download ─────────────────────────────────────────

btnStart.addEventListener("click", async () => {
  if (isRunning || !currentTabId) return;
  isRunning = true;

  btnStart.disabled = true;
  btnStart.textContent = "⏳ Running…";
  btnStop.disabled = false;
  setStatus("running", "Downloading resumes…");
  addLog("Bulk download started.", "info");

  chrome.tabs.sendMessage(currentTabId, { action: "START_DOWNLOAD" });
});

// ── Stop Download ──────────────────────────────────────────

btnStop.addEventListener("click", () => {
  if (!currentTabId) return;
  isRunning = false;
  btnStop.disabled = true;
  btnStart.disabled = false;
  btnStart.textContent = "▶ Resume";
  setStatus("idle", "Download stopped by user");
  addLog("Download stopped by user.", "error");

  chrome.tabs.sendMessage(currentTabId, { action: "STOP_DOWNLOAD" });
});

// ── Listen for progress updates from content script ────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") {
    updateProgress(msg.downloaded, msg.total, msg.failed);
    if (msg.candidateName) {
      addLog(`✓ Downloaded: ${msg.candidateName}`, "success");
    }
  }

  if (msg.type === "DOWNLOAD_ERROR") {
    addLog(`✗ Failed: ${msg.candidateName || "unknown"} — ${msg.error}`, "error");
  }

  if (msg.type === "DONE") {
    isRunning = false;
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnStart.textContent = "✅ Complete";
    setStatus("done", `Finished — ${msg.downloaded} of ${msg.total} downloaded`);
    updateProgress(msg.downloaded, msg.total, msg.failed);
    addLog(`All done! ${msg.downloaded} resume(s) downloaded, ${msg.failed} failed.`, "success");
  }
});

// ── Boot ───────────────────────────────────────────────────
init();
