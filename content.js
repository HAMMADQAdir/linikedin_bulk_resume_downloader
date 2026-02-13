/**
 * content.js – LinkedIn Bulk Resume Downloader
 *
 * LinkedIn's hiring/applicants page uses a TWO-STEP flow:
 *   1. Click the "Resume" button (data-view-name="hiring-applicant-view-resume")
 *      → this opens a resume preview popup/modal.
 *   2. Inside the popup, click the "Download" button (contains svg#download-small
 *      and a span with text "Download") to trigger the actual file download.
 *
 * This script automates both steps with human-like delays.
 */

(() => {
  // Guard against duplicate injection
  if (window.__lbrd_injected) return;
  window.__lbrd_injected = true;

  // ── State ───────────────────────────────────────────────
  let resumeButtons = [];   // The "Resume" preview buttons on the page
  let stopRequested = false;

  // ── Helpers ─────────────────────────────────────────────

  function randomDelay(minSec = 5, maxSec = 15) {
    const ms = (Math.random() * (maxSec - minSec) + minSec) * 1000;
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sanitiseName(raw) {
    return raw
      .trim()
      .replace(/\s+/g, "_")
      .replace(/[^\w\-]/g, "")
      .substring(0, 80) || "Unknown_Candidate";
  }

  // ══════════════════════════════════════════════════════════
  //  STEP 1 — FIND ALL "Resume" PREVIEW BUTTONS
  // ══════════════════════════════════════════════════════════

  function scanForResumeButtons() {
    const found = new Set();

    // ── Primary selector: the exact data attribute from LinkedIn's DOM ──
    document
      .querySelectorAll('button[data-view-name="hiring-applicant-view-resume"]')
      .forEach((el) => found.add(el));

    // ── Fallback selectors (in case LinkedIn renames the attribute) ──

    // Any button whose data-view-name contains "resume"
    document
      .querySelectorAll('button[data-view-name*="resume" i]')
      .forEach((el) => found.add(el));

    // Any button that contains a span whose text is exactly "Resume"
    document.querySelectorAll("button").forEach((btn) => {
      const spans = btn.querySelectorAll("span");
      for (const span of spans) {
        const text = span.textContent.trim();
        if (text === "Resume" || text === "resume") {
          found.add(btn);
          break;
        }
      }
    });

    // Any button containing SVG #document-small (the resume icon)
    document.querySelectorAll('button svg[id="document-small"]').forEach((svg) => {
      const btn = svg.closest("button");
      if (btn) found.add(btn);
    });

    // Aria-label patterns
    try {
      document
        .querySelectorAll('button[aria-label*="resume" i], button[aria-label*="Resume" i]')
        .forEach((el) => found.add(el));
    } catch (_) {}

    // Convert to array and attach candidate names
    resumeButtons = [...found].map((btn) => ({
      element: btn,
      candidateName: extractCandidateName(btn),
    }));

    return resumeButtons.length;
  }

  // ══════════════════════════════════════════════════════════
  //  STEP 2 — FIND THE "Download" BUTTON INSIDE THE POPUP
  // ══════════════════════════════════════════════════════════

  /**
   * After clicking the "Resume" button, a preview popup appears.
   * We need to wait for it and find the download button inside.
   * Returns the download button element, or null.
   */
  async function waitForDownloadButton(maxWaitMs = 8000) {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      // Strategy 1: button containing svg#download-small
      const svgIcon = document.querySelector('svg[id="download-small"]');
      if (svgIcon) {
        const btn = svgIcon.closest("button");
        if (btn) return btn;
      }

      // Strategy 2: button containing a span with text "Download"
      const allButtons = document.querySelectorAll("button");
      for (const btn of allButtons) {
        const spans = btn.querySelectorAll("span");
        for (const span of spans) {
          const text = span.textContent.trim();
          if (text === "Download" || text === "download") {
            return btn;
          }
        }
      }

      // Strategy 3: button with aria-label containing "download"
      try {
        const ariaBtn = document.querySelector(
          'button[aria-label*="Download" i], a[aria-label*="Download" i]'
        );
        if (ariaBtn) return ariaBtn;
      } catch (_) {}

      // Strategy 4: any <a> link that looks like a direct resume download
      const links = document.querySelectorAll("a[href]");
      for (const a of links) {
        const href = (a.href || "").toLowerCase();
        if (
          (href.includes("resume") || href.includes("media") || href.includes(".pdf")) &&
          !href.includes("/hiring/") // exclude navigation links
        ) {
          return a;
        }
      }

      await sleep(500);
    }

    return null;
  }

  /**
   * Try to close the resume preview popup/modal after downloading.
   */
  function closePreviewPopup() {
    // Look for common close/dismiss buttons
    const closeSelectors = [
      'button[aria-label="Dismiss"]',
      'button[aria-label="Close"]',
      'button[aria-label="dismiss"]',
      'button[aria-label="close"]',
      ".artdeco-modal__dismiss",
      'button[data-test-modal-close-btn]',
    ];

    for (const sel of closeSelectors) {
      const closeBtn = document.querySelector(sel);
      if (closeBtn) {
        closeBtn.click();
        return true;
      }
    }

    // Fallback: look for any X / close icon button in a modal
    const modals = document.querySelectorAll(
      '.artdeco-modal, [role="dialog"], [role="presentation"]'
    );
    for (const modal of modals) {
      const closeBtn =
        modal.querySelector('button[aria-label*="lose" i]') ||
        modal.querySelector('button[aria-label*="ismiss" i]') ||
        modal.querySelector("button:first-child");
      if (closeBtn) {
        closeBtn.click();
        return true;
      }
    }

    // Last resort: press Escape
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }

  // ── Name Extraction ─────────────────────────────────────

  function extractCandidateName(element) {
    // 1. Walk up to the applicant card / container
    const containerSelectors = [
      ".hiring-applicant-header",
      ".hiring-applicants__list-item",
      ".artdeco-entity-lockup",
      "#hiring-detail-root",
      ".scaffold-layout__detail",
      '[data-view-name*="applicant"]',
      "[data-test-applicant]",
      ".application-outlet",
      ".hiring-people-card",
      "li",
      "tr",
      "section",
    ];

    let card = null;
    for (const sel of containerSelectors) {
      card = element.closest(sel);
      if (card) break;
    }

    if (card) {
      const nameSelectors = [
        ".artdeco-entity-lockup__title",
        ".hiring-people-card__title",
        ".application-outlet__name",
        "h1", "h2", "h3",
        "span.t-16.t-bold",
        "span.t-bold",
        "a[href*='/in/']",
      ];

      for (const ns of nameSelectors) {
        const nameEl = card.querySelector(ns);
        if (nameEl) {
          const rawText = nameEl.childNodes[0]?.textContent || nameEl.textContent;
          const cleaned = rawText.trim();
          if (cleaned.length > 1 && cleaned.length < 80) {
            return sanitiseName(cleaned);
          }
        }
      }
    }

    // 2. Try the current detail panel heading
    const pageH1 = document.querySelector(
      "#hiring-detail-root h1, .scaffold-layout__detail h1, h1"
    );
    if (pageH1) {
      const name = (pageH1.childNodes[0]?.textContent || pageH1.textContent).trim();
      if (name.length > 1 && name.length < 80) return sanitiseName(name);
    }

    return "Unknown_Candidate";
  }

  // ══════════════════════════════════════════════════════════
  //  MAIN DOWNLOAD LOOP — Two-step: Resume → Preview → Download
  // ══════════════════════════════════════════════════════════

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

      const item = resumeButtons[i];
      const candidateName = item.candidateName;

      try {
        // ── Step 1: Scroll to and click the "Resume" preview button ──
        item.element.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(1000);

        item.element.click();
        notify("LOG", { message: `Opened resume preview for ${candidateName}` });

        // ── Step 2: Wait for the popup & find the Download button ──
        await sleep(1500); // let the popup animate in
        const downloadBtn = await waitForDownloadButton(8000);

        if (!downloadBtn) {
          notify("LOG", { message: `No download button found for ${candidateName}` });
          failed++;
          closePreviewPopup();
          await sleep(500);
          notify("PROGRESS", { downloaded, total, failed });
          continue;
        }

        // ── Step 3: Click the Download button ──
        downloadBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(500);

        // If it's a direct link, send URL to background for clean naming
        if (downloadBtn.tagName === "A" && downloadBtn.href) {
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_RESUME",
            url: downloadBtn.href,
            candidateName: candidateName,
          });
        } else {
          // Click the button — LinkedIn will handle the download natively
          downloadBtn.click();
        }

        downloaded++;
        notify("PROGRESS", { downloaded, total, failed, candidateName });

        // ── Step 4: Close the preview popup ──
        await sleep(1500);
        closePreviewPopup();
        await sleep(800);

      } catch (err) {
        failed++;
        chrome.runtime.sendMessage({
          type: "DOWNLOAD_ERROR",
          candidateName,
          error: err.message,
        });
        notify("PROGRESS", { downloaded, total, failed });

        // Try to clean up any open popup
        closePreviewPopup();
        await sleep(500);
      }

      // ── Human-like delay (5–15 s) before next applicant ──
      if (i < resumeButtons.length - 1 && !stopRequested) {
        await randomDelay(5, 15);
      }
    }

    notify("DONE", { downloaded, total, failed });
  }

  // ── Debug Scan ──────────────────────────────────────────

  function debugScan() {
    const info = {
      url: window.location.href,
      totalButtons: document.querySelectorAll("button").length,
      totalLinks: document.querySelectorAll("a").length,
    };

    // Count "Resume" preview buttons
    const resumeBtns = document.querySelectorAll(
      'button[data-view-name="hiring-applicant-view-resume"]'
    );
    info.resumePreviewButtons = resumeBtns.length;

    // Check for the download icon
    const downloadIcons = document.querySelectorAll('svg[id="download-small"]');
    info.downloadIconsVisible = downloadIcons.length;

    // All buttons with data-view-name
    const dataViewButtons = document.querySelectorAll("button[data-view-name]");
    info.dataViewButtons = [...dataViewButtons].map((el) => ({
      dataViewName: el.getAttribute("data-view-name"),
      text: el.textContent.trim().substring(0, 60),
    }));

    // All buttons whose text contains "Resume" or "Download"
    info.relevantButtons = [];
    document.querySelectorAll("button").forEach((btn) => {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes("resume") || text.includes("download")) {
        info.relevantButtons.push({
          text: btn.textContent.trim().substring(0, 60),
          dataViewName: btn.getAttribute("data-view-name") || "",
          ariaLabel: btn.getAttribute("aria-label") || "",
          className: (btn.className || "").toString().substring(0, 80),
        });
      }
    });

    // All leaf elements with "resume" or "download" text
    info.allResumeDownloadLeafs = [];
    document.querySelectorAll("*").forEach((node) => {
      if (node.children.length > 0) return;
      const text = (node.textContent || "").toLowerCase();
      if (text.includes("resume") || text.includes("download")) {
        info.allResumeDownloadLeafs.push({
          tag: node.tagName,
          text: node.textContent.trim().substring(0, 60),
          parentTag: node.parentElement?.tagName || "",
          parentDataView: node.parentElement?.getAttribute?.("data-view-name") || "",
        });
        if (info.allResumeDownloadLeafs.length >= 30) return;
      }
    });

    return info;
  }

  // ── Messaging ───────────────────────────────────────────

  function notify(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  // ── Message Listener ────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "SCAN_RESUMES": {
        const count = scanForResumeButtons();
        sendResponse({ count });
        break;
      }

      case "DEBUG_SCAN": {
        const info = debugScan();
        sendResponse({ debug: info });
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

    return true;
  });

  console.log("[LBRD] LinkedIn Bulk Resume Downloader content script loaded.");
})();
