/**
 * content.js – LinkedIn Bulk Resume Downloader
 * Runs on LinkedIn hiring / talent pages.
 * Detects resume download buttons, clicks them one-by-one with randomised
 * human-like delays, and forwards download URLs to the background worker.
 */

(() => {
  // Guard against duplicate injection
  if (window.__lbrd_injected) return;
  window.__lbrd_injected = true;

  // ── State ───────────────────────────────────────────────
  let resumeButtons = [];
  let stopRequested = false;

  // ── Selectors ───────────────────────────────────────────
  // LinkedIn can change its DOM; we try several possible selectors.
  const BUTTON_SELECTORS = [
    'button[aria-label*="Download resume"]',
    'button[aria-label*="download resume"]',
    'button[aria-label*="Download Resume"]',
    'a[aria-label*="Download resume"]',
    'a[aria-label*="download resume"]',
    'button[data-test-download-resume]',
    'button[data-view-name="hiring-applicant-view-resume"]',
    // Fallback: any link/button whose text says "Download" inside an
    // applicant card context
    '.hiring-applicant-header button[aria-label*="Download"]',
    '.hiring-applicant-header a[aria-label*="Download"]',
    '.artdeco-modal button[aria-label*="Download"]',
  ];

  // ── Helpers ─────────────────────────────────────────────

  /** Create a random delay between min and max milliseconds */
  function randomDelay(minSec = 5, maxSec = 15) {
    const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Sleep helper */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Try to extract the candidate name near a download button */
  function extractCandidateName(button) {
    // Strategy 1: aria-label often contains the name
    const ariaLabel = button.getAttribute("aria-label") || "";
    // e.g. "Download resume for John Doe"
    const match = ariaLabel.match(/Download\s+resume\s+(?:for\s+)?(.+)/i);
    if (match && match[1]) return sanitiseName(match[1]);

    // Strategy 2: walk up to the applicant card and look for a heading / link
    const card =
      button.closest(".hiring-applicant-header") ||
      button.closest(".artdeco-entity-lockup") ||
      button.closest("[data-test-applicant]") ||
      button.closest(".hiring-applicants-list-item") ||
      button.closest("li");

    if (card) {
      const nameEl =
        card.querySelector("h3") ||
        card.querySelector("h2") ||
        card.querySelector(".artdeco-entity-lockup__title") ||
        card.querySelector("a[data-control-name]") ||
        card.querySelector("span.t-16") ||
        card.querySelector("span.t-bold");
      if (nameEl) return sanitiseName(nameEl.textContent);
    }

    // Strategy 3: previous sibling text
    const prev = button.previousElementSibling;
    if (prev && prev.textContent.trim().length > 1 && prev.textContent.trim().length < 80) {
      return sanitiseName(prev.textContent);
    }

    return "Unknown_Candidate";
  }

  /** Clean a name string so it's filesystem-friendly */
  function sanitiseName(raw) {
    return raw
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^\w\-]/g, "")
      .substring(0, 80) || "Unknown_Candidate";
  }

  /** Scan the page for resume download buttons */
  function scanForButtons() {
    const found = new Set();

    for (const selector of BUTTON_SELECTORS) {
      document.querySelectorAll(selector).forEach((el) => found.add(el));
    }

    // Additional heuristic: any <a> whose href contains "media" and "resume"
    document.querySelectorAll('a[href*="resume"], a[href*="Resume"]').forEach((el) => {
      if (el.href && (el.href.includes(".pdf") || el.href.includes("media"))) {
        found.add(el);
      }
    });

    resumeButtons = [...found];
    return resumeButtons.length;
  }

  /**
   * Attempt to intercept the actual download URL.
   * LinkedIn usually triggers a fetch/XHR when the download button is clicked;
   * we listen for that network request and capture the URL.
   */
  function interceptDownloadUrl(button) {
    return new Promise((resolve) => {
      // If the element is a direct <a> with href, just use that
      if (button.tagName === "A" && button.href) {
        resolve(button.href);
        return;
      }

      // Otherwise, set up a temporary observer for any new <a> downloads or
      // network fetches triggered by clicking the button.
      let resolved = false;

      // Intercept via download attribute trick
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.tagName === "A" && node.href) {
              resolved = true;
              observer.disconnect();
              resolve(node.href);
              return;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Monkey-patch fetch temporarily to capture the resume URL
      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (
          !resolved &&
          (url.includes("resume") || url.includes("media") || url.includes(".pdf"))
        ) {
          resolved = true;
          observer.disconnect();
          window.fetch = origFetch;
          resolve(url);
        }
        return origFetch.apply(this, args);
      };

      // Click the button
      button.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => {
        button.click();

        // Fallback: if nothing intercepted in 4 seconds, resolve empty
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            observer.disconnect();
            window.fetch = origFetch;
            resolve("");
          }
        }, 4000);
      }, 500);
    });
  }

  // ── Main Download Loop ──────────────────────────────────

  async function startBulkDownload() {
    stopRequested = false;
    const total = resumeButtons.length;
    let downloaded = 0;
    let failed = 0;

    for (let i = 0; i < resumeButtons.length; i++) {
      if (stopRequested) {
        notify("DONE", { downloaded, total, failed });
        return;
      }

      const btn = resumeButtons[i];
      const candidateName = extractCandidateName(btn);

      try {
        // Scroll to button so it's visible (mimic human behaviour)
        btn.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(800);

        // Try to get the download URL
        const downloadUrl = await interceptDownloadUrl(btn);

        if (downloadUrl) {
          // Send URL to background for clean download with proper filename
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_RESUME",
            url: downloadUrl,
            candidateName: candidateName,
          });
          downloaded++;
        } else {
          // Fallback: just click the button directly (LinkedIn will trigger
          // a native download)
          btn.click();
          downloaded++;
        }

        // Notify popup of progress
        notify("PROGRESS", {
          downloaded,
          total,
          failed,
          candidateName,
        });
      } catch (err) {
        failed++;
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_ERROR",
          candidateName,
          error: err.message,
        });
        notify("PROGRESS", { downloaded, total, failed });
      }

      // ── Human-like delay (5-15 s) before next download ──
      if (i < resumeButtons.length - 1 && !stopRequested) {
        await randomDelay(5, 15);
      }
    }

    notify("DONE", { downloaded, total, failed });
  }

  /** Send a message to popup / background */
  function notify(type, data) {
    chrome.runtime.sendMessage({ type, ...data });
  }

  // ── Message Listener ────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "SCAN_RESUMES": {
        const count = scanForButtons();
        sendResponse({ count });
        break;
      }

      case "START_DOWNLOAD":
        startBulkDownload();
        sendResponse({ ok: true });
        break;

      case "STOP_DOWNLOAD":
        stopRequested = true;
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false });
    }

    return true; // keep channel open for async response
  });
})();
