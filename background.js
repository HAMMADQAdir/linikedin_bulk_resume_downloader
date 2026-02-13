/**
 * background.js – LinkedIn Bulk Resume Downloader (Service Worker)
 * Handles download queueing, clean filename naming, and message relay.
 */

// ── Download Queue ────────────────────────────────────────
const downloadQueue = [];
let isProcessingQueue = false;

// ── PDF Tab Watcher ───────────────────────────────────────
// When content script signals EXPECT_PDF_TAB, we watch for new tabs
// opened from LinkedIn and auto-download + close them.
let pendingPdfDownload = null;   // { candidateName, timeoutId, sourceTabId }

// ── Message Listener ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Download request from content script ────────────────
  if (msg.type === "DOWNLOAD_RESUME") {
    enqueueDownload(msg.url, msg.candidateName);
    sendResponse({ queued: true });
    return true;
  }

  // ── Expect a new PDF tab (content script couldn't grab URL) ──
  if (msg.type === "EXPECT_PDF_TAB") {
    clearPdfWatch();
    pendingPdfDownload = {
      candidateName: msg.candidateName,
      sourceTabId: sender.tab ? sender.tab.id : -1,
      timeoutId: setTimeout(clearPdfWatch, 30000), // 30s safety timeout
    };
    console.log(`[LBRD] Watching for PDF tab for: ${msg.candidateName} (source tab: ${pendingPdfDownload.sourceTabId})`);
    sendResponse({ ok: true });
    return true;
  }

  // ── Relay progress / done / error messages to popup ─────
  if (["PROGRESS", "DONE", "DOWNLOAD_ERROR", "LOG"].includes(msg.type)) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }

  return false;
});

function clearPdfWatch() {
  if (pendingPdfDownload) {
    clearTimeout(pendingPdfDownload.timeoutId);
    pendingPdfDownload = null;
  }
}

function isPdfLikeUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes(".pdf") ||
    lower.includes("mediaauth") ||
    lower.includes("ambry") ||
    lower.includes("dms/") ||
    lower.includes("media.licdn.com") ||
    lower.includes("resumeViewer") ||
    lower.includes("resume") ||
    (lower.includes("licdn.com") && !lower.includes(".js") && !lower.includes(".css"))
  );
}

// ── Watch for new tabs — ANY new tab counts while expecting PDF ──

function handleNewTabUrl(tabId, url) {
  if (!pendingPdfDownload) return;
  if (!url || url === "" || url === "about:blank" || url === "chrome://newtab/") return;
  if (tabId === pendingPdfDownload.sourceTabId) return; // skip the source tab

  const candidateName = pendingPdfDownload.candidateName;
  console.log(`[LBRD] New tab detected (tabId=${tabId}): ${url.substring(0, 120)}`);

  // Download the PDF and close the tab
  enqueueDownload(url, candidateName);
  clearPdfWatch();

  // Close the PDF tab after giving download API a moment to start
  setTimeout(() => {
    chrome.tabs.remove(tabId).catch(() => {});
  }, 2000);
}

chrome.tabs.onCreated.addListener((tab) => {
  if (!pendingPdfDownload) return;
  const url = tab.pendingUrl || tab.url || "";
  console.log(`[LBRD] tabs.onCreated: tabId=${tab.id}, url=${url.substring(0, 80)}`);
  if (url && url !== "about:blank" && url !== "chrome://newtab/") {
    handleNewTabUrl(tab.id, url);
  }
  // If URL is blank, onUpdated will fire later with the real URL
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!pendingPdfDownload) return;
  // Only act on URL changes or when loading completes
  const url = changeInfo.url || "";
  if (url) {
    handleNewTabUrl(tabId, url);
  }
});

// ── Queue Processor ───────────────────────────────────────

function enqueueDownload(url, candidateName) {
  const filename = buildFilename(candidateName);
  downloadQueue.push({ url, filename });

  if (!isProcessingQueue) {
    processQueue();
  }
}

async function processQueue() {
  isProcessingQueue = true;

  while (downloadQueue.length > 0) {
    const { url, filename } = downloadQueue.shift();

    try {
      await triggerDownload(url, filename);
    } catch (err) {
      console.warn("[LBRD] Download failed:", filename, err);
    }

    // Small gap between downloads to prevent Chrome from throttling
    await sleep(500);
  }

  isProcessingQueue = false;
}

// ── Chrome Downloads API ──────────────────────────────────

function triggerDownload(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: url,
        filename: `LinkedIn_Resumes/${filename}`,
        conflictAction: "uniquify",   // auto-rename if duplicate
        saveAs: false,                 // silent download
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        console.log(`[LBRD] Download started: ${filename} (id: ${downloadId})`);
        resolve(downloadId);
      }
    );
  });
}

// ── Filename Builder ──────────────────────────────────────

function buildFilename(candidateName) {
  // Sanitise: keep only word chars, hyphens, underscores
  let safe = (candidateName || "Unknown_Candidate")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-]/g, "")
    .substring(0, 80);

  if (!safe) safe = "Unknown_Candidate";

  // Append timestamp to guarantee uniqueness
  const ts = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `${safe}_Resume_${ts}.pdf`;
}

// ── Utility ───────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Extension Install / Update Hook ──────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("[LBRD] LinkedIn Bulk Resume Downloader installed.");
  }
});
