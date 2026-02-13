/**
 * background.js – LinkedIn Bulk Resume Downloader (Service Worker)
 * Handles download queueing, clean filename naming, and message relay.
 */

// ── Download Queue ────────────────────────────────────────
const downloadQueue = [];
let isProcessingQueue = false;

// ── Message Listener ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ── Download request from content script ────────────────
  if (msg.type === "DOWNLOAD_RESUME") {
    enqueueDownload(msg.url, msg.candidateName);
    sendResponse({ queued: true });
    return true;
  }

  // ── Relay progress / done / error messages to popup ─────
  if (["PROGRESS", "DONE", "DOWNLOAD_ERROR"].includes(msg.type)) {
    // Forward to popup (all extension views will receive it)
    chrome.runtime.sendMessage(msg).catch(() => {
      // Popup may be closed — safe to ignore
    });
  }

  return false;
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
