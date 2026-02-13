/**
 * content.js – LinkedIn Bulk Resume Downloader  (v5)
 *
 * LinkedIn uses obfuscated/hashed CSS class names that change frequently,
 * so we detect elements by STRUCTURE and CONTENT, not class names.
 *
 * Flow per applicant:
 *   1. Click applicant card in LEFT list → loads detail in RIGHT panel
 *   2. Click "Resume" button (has data-view-name or svg#document-small)
 *   3. Click "Download" button (has svg#download-small) in popup
 *   4. Close popup → wait 5-15 s → next applicant
 */

// Allow re-injection on extension reload
if (window.__lbrd_cleanup) {
  try { window.__lbrd_cleanup(); } catch (_) {}
}

(() => {
  let applicantCards = [];
  let stopRequested = false;

  // ── Helpers ─────────────────────────────────────────────

  const randomDelay = (min = 0, max = 5) =>
    new Promise((r) => setTimeout(r, (Math.random() * (max - min) + min) * 1000));

  // Random sleep: 0 to ms
  const rsleep = (ms) => new Promise((r) => setTimeout(r, Math.random() * ms));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sanitiseName(raw) {
    return raw.trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "").substring(0, 80) || "Unknown_Candidate";
  }

  function log(msg) {
    console.log(`[LBRD] ${msg}`);
    notify("LOG", { message: msg });
  }

  // ══════════════════════════════════════════════════════════
  //  SCAN — find applicant cards using CONTENT-BASED detection
  // ══════════════════════════════════════════════════════════

  function scanApplicantCards() {
    const found = new Map();

    // ── Strategy 1: data-view-name on applicant items ──
    // LinkedIn often puts data-view-name on list items
    document.querySelectorAll('[data-view-name*="applicant" i]').forEach((el) => {
      if (!found.has(el)) found.set(el, extractNameFromCard(el));
    });

    // Also check componentkey items (LinkedIn uses this extensively)
    document.querySelectorAll('[componentkey]').forEach((el) => {
      // Only cards in a list-like context, not the detail panel
      const text = el.textContent;
      const looksLikeCard =
        (text.includes("Must-have") || text.includes("Preferred") ||
         text.includes("/3") || text.includes("/5") ||
         text.includes("1st") || text.includes("2nd") || text.includes("3rd")) &&
        el.textContent.trim().length < 500 &&
        el.textContent.trim().length > 20;

      // Make sure it's not the detail panel (which is larger)
      if (looksLikeCard && !found.has(el)) {
        // Check it's not already a child of something we found
        let isDuplicate = false;
        for (const existing of found.keys()) {
          if (existing.contains(el) || el.contains(existing)) {
            isDuplicate = true;
            break;
          }
        }
        if (!isDuplicate) found.set(el, extractNameFromCard(el));
      }
    });

    // ── Strategy 2: Find the list container and its children ──
    // The left panel is usually a scrollable container with repeating children
    if (found.size === 0) {
      // Find all scrollable containers
      const allElements = document.querySelectorAll("*");
      let bestContainer = null;
      let bestScore = 0;

      for (const el of allElements) {
        // A list container should have multiple similar children and be scrollable
        const children = el.children;
        if (children.length < 2) continue;

        // Check if it looks like a list of applicant cards
        let matchingChildren = 0;
        for (const child of children) {
          const text = child.textContent;
          if (
            (text.includes("Must-have") || text.includes("Preferred") ||
             text.includes("/3") || text.includes("/5")) &&
            (text.includes("1st") || text.includes("2nd") || text.includes("3rd") ||
             text.includes("India") || text.includes("·"))
          ) {
            matchingChildren++;
          }
        }

        if (matchingChildren > bestScore) {
          bestScore = matchingChildren;
          bestContainer = el;
        }
      }

      if (bestContainer && bestScore >= 2) {
        log(`  Strategy 2: Found list container with ${bestScore} applicant children`);
        for (const child of bestContainer.children) {
          const text = child.textContent;
          const looksLikeCard =
            (text.includes("Must-have") || text.includes("Preferred") ||
             text.includes("/3") || text.includes("/5")) &&
            text.trim().length > 20 && text.trim().length < 500;
          if (looksLikeCard && !found.has(child)) {
            found.set(child, extractNameFromCard(child));
          }
        }
      }
    }

    // ── Strategy 3: Role-based — look for [role="list"] → [role="listitem"] ──
    if (found.size === 0) {
      document.querySelectorAll('[role="list"]').forEach((list) => {
        const items = list.querySelectorAll('[role="listitem"], li, [role="option"]');
        items.forEach((item) => {
          const text = item.textContent;
          if (
            text.trim().length > 20 && text.trim().length < 500 &&
            (text.includes("·") || text.includes("2nd") || text.includes("3rd") || text.includes("1st"))
          ) {
            if (!found.has(item)) found.set(item, extractNameFromCard(item));
          }
        });
      });
    }

    // ── Strategy 4: Anchor links with hiring/applicant URLs ──
    if (found.size === 0) {
      document.querySelectorAll('a[href*="applicationId"], a[href*="applicant"]').forEach((a) => {
        // Walk up to the card container
        const card = a.closest("li") || a.closest("[componentkey]") || a.parentElement;
        if (card && !found.has(card) && card.textContent.trim().length > 20) {
          found.set(card, extractNameFromCard(card));
        }
      });
    }

    // ── Strategy 5: ULTRA-broad — find siblings of the detail panel ──
    if (found.size === 0) {
      // The "Shortlist" or "Applicants" heading is usually above the list
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let textNode;
      while ((textNode = walker.nextNode())) {
        const t = textNode.textContent.trim();
        if (t === "Shortlist" || t === "Applicants" || t === "All applicants") {
          // Go up to find the list container near this heading
          let parent = textNode.parentElement;
          for (let depth = 0; depth < 5 && parent; depth++) {
            parent = parent.parentElement;
          }
          if (parent) {
            // Look for repeating child patterns
            const candidates = parent.querySelectorAll("*");
            for (const c of candidates) {
              if (
                c.children.length === 0 || c.children.length > 10 ||
                c.textContent.trim().length > 500 || c.textContent.trim().length < 20
              ) continue;
              const text = c.textContent;
              if (
                (text.includes("·") || text.includes("2nd") || text.includes("3rd")) &&
                (text.includes("/3") || text.includes("/5") || text.includes("Must-have"))
              ) {
                if (!found.has(c)) found.set(c, extractNameFromCard(c));
              }
            }
          }
          break;
        }
      }
    }

    // De-duplicate: if a parent and child are both in the map, keep only the child
    const toRemove = [];
    for (const a of found.keys()) {
      for (const b of found.keys()) {
        if (a !== b && a.contains(b)) {
          toRemove.push(a); // remove the parent
        }
      }
    }
    for (const el of toRemove) found.delete(el);

    applicantCards = [...found].map(([el, name]) => ({ element: el, name }));
    log(`Scan complete: ${applicantCards.length} applicant(s) found.`);
    if (applicantCards.length > 0) {
      log(`  Names: ${applicantCards.map((c) => c.name).join(", ")}`);
    }
    return applicantCards.length;
  }

  function extractNameFromCard(card) {
    // Look for the first bold/name-like text that appears to be a person name
    // Names on LinkedIn are usually: "FirstName LastName ✓ · 2nd"

    // 1. Try known name selectors
    for (const sel of [
      "h2", "h3", "h4",
      'a[href*="/in/"]',
      'a[href*="/talent/profile/"]',
    ]) {
      const el = card.querySelector(sel);
      if (el) {
        const raw = (el.childNodes[0]?.textContent || el.textContent).trim();
        if (raw.length > 1 && raw.length < 60) return sanitiseName(raw);
      }
    }

    // 2. Take the first line of text — usually the name
    const text = card.textContent.trim();
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length > 0) {
      // First non-empty line is usually the name
      let name = lines[0];
      // Clean connection badges like "· 2nd", "✓"
      name = name.replace(/[·•].*$/, "").replace(/[✓✔☑️]/, "").trim();
      if (name.length > 1 && name.length < 60) return sanitiseName(name);
    }

    return "Unknown_Candidate";
  }

  // ══════════════════════════════════════════════════════════
  //  SELECT APPLICANT — click their card
  // ══════════════════════════════════════════════════════════

  async function selectApplicant(card) {
    const el = card.element;

    // Find clickable target: prefer <a> links, then the element itself
    const clickTarget =
      el.querySelector('a[href*="applicationId"]') ||
      el.querySelector('a[href*="applicant"]') ||
      el.querySelector('a[href*="hiring"]') ||
      el.querySelector("a") ||
      el;

    log(`  Clicking: <${clickTarget.tagName}> "${clickTarget.textContent.trim().substring(0, 40)}…"`);
    clickTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    await rsleep(400);

    // Full mouse event sequence for realism
    for (const type of ["mousedown", "mouseup", "click"]) {
      clickTarget.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }

    await sleep(800 + Math.random() * 700); // wait for detail panel to load
  }

  // ══════════════════════════════════════════════════════════
  //  FIND "Resume" BUTTON
  // ══════════════════════════════════════════════════════════

  async function findResumeButton(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // 1. data-view-name (from the HTML you shared)
      let btn = document.querySelector('button[data-view-name="hiring-applicant-view-resume"]');
      if (btn) { log("  ✓ Found Resume via data-view-name"); return btn; }

      btn = document.querySelector('button[data-view-name*="resume" i]');
      if (btn) { log("  ✓ Found Resume via partial data-view-name"); return btn; }

      // 2. SVG icon #document-small
      const docIcon = document.querySelector('svg[id="document-small"]');
      if (docIcon) {
        btn = docIcon.closest("button");
        if (btn) { log("  ✓ Found Resume via svg#document-small"); return btn; }
      }

      // 3. Leaf span with text "Resume" inside a button
      for (const b of document.querySelectorAll("button")) {
        for (const span of b.querySelectorAll("span")) {
          if (span.children.length === 0 && span.textContent.trim() === "Resume") {
            log("  ✓ Found Resume via span text"); return b;
          }
        }
      }

      await sleep(500);
    }
    log("  ⚠ Resume button NOT found"); return null;
  }

  // ══════════════════════════════════════════════════════════
  //  FIND "Download" BUTTON inside the resume popup
  // ══════════════════════════════════════════════════════════

  async function findDownloadButton(maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // 1. SVG icon #download-small (from the HTML you shared)
      const dlIcon = document.querySelector('svg[id="download-small"]');
      if (dlIcon) {
        const btn = dlIcon.closest("button") || dlIcon.closest("a");
        if (btn) { log("  ✓ Found Download via svg#download-small"); return btn; }
      }

      // 2. Leaf span with exact text "Download"
      for (const b of document.querySelectorAll("button")) {
        for (const span of b.querySelectorAll("span")) {
          if (span.children.length === 0 && span.textContent.trim() === "Download") {
            log("  ✓ Found Download via span text"); return b;
          }
        }
      }

      // 3. aria-label
      try {
        const ariaBtn = document.querySelector('button[aria-label*="Download" i]');
        if (ariaBtn) { log("  ✓ Found Download via aria-label"); return ariaBtn; }
      } catch (_) {}

      // 4. Direct download link
      for (const a of document.querySelectorAll("a[href]")) {
        const href = (a.href || "").toLowerCase();
        if (
          (href.includes("resume") || href.includes(".pdf") || href.includes("mediaauth")) &&
          !href.includes("/hiring/") && !href.includes("/jobs/")
        ) {
          log("  ✓ Found Download via href"); return a;
        }
      }

      await sleep(500);
    }
    log("  ⚠ Download button NOT found"); return null;
  }

  // ══════════════════════════════════════════════════════════
  //  EXTRACT PDF URL from the resume preview popup
  // ══════════════════════════════════════════════════════════

  function extractPdfUrl() {
    // 1. Check <iframe> sources (LinkedIn often renders PDF in an iframe)
    for (const iframe of document.querySelectorAll("iframe")) {
      const src = iframe.src || "";
      if (src && (src.includes(".pdf") || src.includes("mediaauth") || src.includes("resume") || src.includes("dms/"))) {
        log(`  ✓ PDF URL from iframe: ${src.substring(0, 80)}…`);
        return src;
      }
    }

    // 2. Check <embed> elements
    for (const embed of document.querySelectorAll("embed")) {
      const src = embed.src || "";
      if (src && (src.includes(".pdf") || src.includes("mediaauth") || src.includes("resume"))) {
        log(`  ✓ PDF URL from embed: ${src.substring(0, 80)}…`);
        return src;
      }
    }

    // 3. Check <object> elements
    for (const obj of document.querySelectorAll("object")) {
      const data = obj.data || "";
      if (data && (data.includes(".pdf") || data.includes("mediaauth") || data.includes("resume"))) {
        log(`  ✓ PDF URL from object: ${data.substring(0, 80)}…`);
        return data;
      }
    }

    // 4. Check anchors near the download button / in modal / dialog
    const modals = document.querySelectorAll('[role="dialog"], [role="presentation"], [class*="modal"], [class*="overlay"]');
    for (const modal of modals) {
      for (const a of modal.querySelectorAll("a[href]")) {
        const href = a.href || "";
        if (href && (href.includes(".pdf") || href.includes("mediaauth") || href.includes("dms/"))) {
          log(`  ✓ PDF URL from modal anchor: ${href.substring(0, 80)}…`);
          return href;
        }
      }
    }

    // 5. Broad search for any anchor with PDF-like URL in the whole page
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.href || "";
      if (
        href &&
        (href.includes(".pdf") || href.includes("mediaauth")) &&
        !href.includes("/hiring/") && !href.includes("/jobs/") && !href.includes("/in/")
      ) {
        log(`  ✓ PDF URL from page anchor: ${href.substring(0, 80)}…`);
        return href;
      }
    }

    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  FETCH + BLOB DOWNLOAD — downloads PDF with session cookies
  //  This avoids the one-time-token problem where chrome.downloads
  //  makes a second HTTP request that fails.
  // ══════════════════════════════════════════════════════════

  function buildDownloadFilename(candidateName) {
    let safe = (candidateName || "Unknown_Candidate")
      .trim().replace(/\s+/g, "_").replace(/[^\w\-]/g, "").substring(0, 80);
    if (!safe) safe = "Unknown_Candidate";
    const ts = new Date().toISOString().slice(0, 10);
    return `${safe}_Resume_${ts}.pdf`;
  }

  async function downloadViaFetch(url, candidateName) {
    const filename = buildDownloadFilename(candidateName);
    log(`  Fetching PDF blob from: ${url.substring(0, 80)}…`);
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
      log(`  ✓ Blob download triggered: ${filename}`);
      return true;
    } catch (err) {
      log(`  ⚠ Fetch-blob failed: ${err.message}`);
      return false;
    }
  }

  // ══════════════════════════════════════════════════════════
  //  INTERCEPT window.open IN THE MAIN WORLD via <script> injection
  //  Content scripts run in an isolated world — they CANNOT override
  //  the page's window.open. We must inject into the page itself.
  //  The injected code ALSO fetches the PDF as a blob and triggers
  //  a download directly (so the one-time URL isn't wasted).
  // ══════════════════════════════════════════════════════════

  let interceptedUrl = null;
  let mainWorldDownloaded = false;
  let interceptListenerActive = false;

  function startWindowOpenIntercept(candidateName) {
    interceptedUrl = null;
    mainWorldDownloaded = false;

    // Listen for messages from the injected page script (only add once)
    if (!interceptListenerActive) {
      window.addEventListener("message", onInterceptMessage);
      interceptListenerActive = true;
    }

    const filename = buildDownloadFilename(candidateName);

    // Inject a <script> into the page's main world
    // Re-inject every time to update the filename for the current candidate
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        if (!window.__lbrd_origOpen) {
          window.__lbrd_origOpen = window.open;
        }
        window.__lbrd_currentFilename = ${JSON.stringify(filename)};
        window.open = function(url) {
          var s = String(url || "");
          window.postMessage({ __lbrd_intercepted: true, url: s }, "*");
          fetch(s, { credentials: "include" })
            .then(function(r) { return r.blob(); })
            .then(function(blob) {
              var u = URL.createObjectURL(blob);
              var a = document.createElement("a");
              a.href = u;
              a.download = window.__lbrd_currentFilename || "Resume.pdf";
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(function() { URL.revokeObjectURL(u); }, 15000);
              window.postMessage({ __lbrd_download_done: true }, "*");
            })
            .catch(function(err) {
              window.postMessage({ __lbrd_download_failed: true, error: err.message }, "*");
            });
          return null;
        };
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  function onInterceptMessage(event) {
    if (event.source !== window) return;
    if (event.data && event.data.__lbrd_intercepted) {
      interceptedUrl = event.data.url;
      log(`  ✓ Intercepted URL (main world): ${interceptedUrl.substring(0, 80)}…`);
    }
    if (event.data && event.data.__lbrd_download_done) {
      mainWorldDownloaded = true;
      log("  ✓ Main-world fetch+download succeeded!");
    }
    if (event.data && event.data.__lbrd_download_failed) {
      log(`  ⚠ Main-world fetch failed: ${event.data.error}`);
    }
  }

  // Don't restore window.open between downloads — keep it patched
  function checkInterceptResult() {
    const result = { url: interceptedUrl, downloadedInMainWorld: mainWorldDownloaded };
    interceptedUrl = null;
    mainWorldDownloaded = false;
    return result;
  }

  // ══════════════════════════════════════════════════════════
  //  INTERCEPT <a target="_blank"> clicks (another way LinkedIn opens PDFs)
  // ══════════════════════════════════════════════════════════

  function interceptLinkClicks() {
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        document.addEventListener("click", function(e) {
          var a = e.target.closest ? e.target.closest("a") : null;
          if (a && a.href && (a.target === "_blank" || a.getAttribute("target") === "_blank")) {
            var href = a.href.toLowerCase();
            if (href.includes(".pdf") || href.includes("mediaauth") || href.includes("resume")
                || href.includes("dms/") || href.includes("media.licdn")) {
              e.preventDefault();
              e.stopPropagation();
              window.postMessage({ __lbrd_intercepted: true, url: a.href }, "*");
              // Also fetch and download
              fetch(a.href, { credentials: "include" })
                .then(function(r) { return r.blob(); })
                .then(function(blob) {
                  var u = URL.createObjectURL(blob);
                  var el = document.createElement("a");
                  el.href = u;
                  el.download = "Resume.pdf";
                  document.body.appendChild(el);
                  el.click();
                  el.remove();
                  setTimeout(function() { URL.revokeObjectURL(u); }, 15000);
                  window.postMessage({ __lbrd_download_done: true }, "*");
                })
                .catch(function() {});
            }
          }
        }, true);
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

  // Inject link click interceptor on load
  interceptLinkClicks();

  // ══════════════════════════════════════════════════════════
  //  CLOSE popup
  // ══════════════════════════════════════════════════════════

  async function closePreviewPopup() {
    for (const sel of [
      'button[aria-label="Dismiss"]', 'button[aria-label="Close"]',
      'button[aria-label="dismiss"]', 'button[aria-label="close"]',
      ".artdeco-modal__dismiss", 'button[data-test-modal-close-btn]',
    ]) {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); log("  Closed popup"); await rsleep(300); return; }
    }

    for (const modal of document.querySelectorAll('[role="dialog"], [role="presentation"]')) {
      const btn = modal.querySelector('button[aria-label*="ismiss" i], button[aria-label*="lose" i]');
      if (btn) { btn.click(); log("  Closed modal"); await rsleep(300); return; }
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    log("  Sent Escape"); await rsleep(300);
  }

  // ══════════════════════════════════════════════════════════
  //  MAIN DOWNLOAD LOOP
  // ══════════════════════════════════════════════════════════

  async function startBulkDownload() {
    stopRequested = false;
    const total = applicantCards.length;
    let downloaded = 0, failed = 0;

    log(`Starting bulk download for ${total} applicant(s)…`);

    // Notify background so popup can reconnect
    chrome.runtime.sendMessage({ type: "DOWNLOAD_STARTED", total }).catch(() => {});

    for (let i = 0; i < applicantCards.length; i++) {
      if (stopRequested) { notify("DONE", { downloaded, total, failed }); chrome.runtime.sendMessage({ type: "DOWNLOAD_STOPPED" }).catch(() => {}); return; }

      const card = applicantCards[i];
      const name = card.name;
      log(`\n━━━ [${i + 1}/${total}] ${name} ━━━`);

      try {
        log("  Step 1: Selecting applicant…");
        await selectApplicant(card);

        log("  Step 2: Looking for Resume button…");
        const resumeBtn = await findResumeButton(10000);
        if (!resumeBtn) {
          log(`  ✗ No Resume button for ${name}`); failed++;
          notify("PROGRESS", { downloaded, total, failed });
          if (i < applicantCards.length - 1) await randomDelay(0, 3);
          continue;
        }

        resumeBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        await rsleep(200);
        log("  Step 2: Clicking Resume…");
        resumeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        log("  Step 3: Waiting for popup…");
        await sleep(600 + Math.random() * 600);
        const downloadBtn = await findDownloadButton(10000);
        if (!downloadBtn) {
          log(`  ✗ No Download button for ${name}`); failed++;
          await closePreviewPopup();
          notify("PROGRESS", { downloaded, total, failed });
          if (i < applicantCards.length - 1) await randomDelay(0, 3);
          continue;
        }

        downloadBtn.scrollIntoView({ behavior: "smooth", block: "center" });
        await rsleep(150);

        // ── Always tell background to watch for new PDF tabs as LAST-RESORT safety net ──
        chrome.runtime.sendMessage({ type: "EXPECT_PDF_TAB", candidateName: name });

        // ── Try to extract the PDF URL directly from the preview ──
        let pdfUrl = extractPdfUrl();
        let dlSuccess = false;

        if (pdfUrl) {
          // We already have the URL — fetch as blob and download
          log(`  Step 3: Direct PDF URL found, fetching blob…`);
          dlSuccess = await downloadViaFetch(pdfUrl, name);
          if (!dlSuccess) {
            // Fallback: send to background
            log(`  Step 3: Blob failed, sending URL to background…`);
            chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", url: pdfUrl, candidateName: name });
          }
        } else if (downloadBtn.tagName === "A" && downloadBtn.href) {
          // It's a link — fetch as blob
          log(`  Step 3: Download link href found, fetching blob…`);
          dlSuccess = await downloadViaFetch(downloadBtn.href, name);
          if (!dlSuccess) {
            chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", url: downloadBtn.href, candidateName: name });
          }
        } else {
          // Must click the button — intercept window.open in main world
          // The injected script will ALSO fetch+download the PDF as a blob
          log("  Step 3: Clicking Download (with main-world interception + fetch)…");

          startWindowOpenIntercept(name);

          // Click the download button
          downloadBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

          await sleep(1500 + Math.random() * 1500); // wait for fetch+download in main world

          const result = checkInterceptResult();
          if (result.downloadedInMainWorld) {
            log("  ✓ Downloaded via main-world fetch!");
            dlSuccess = true;
          } else if (result.url) {
            // Main world fetch failed but we got the URL — try from content script
            log("  Step 3: Trying content-script fetch with captured URL…");
            dlSuccess = await downloadViaFetch(result.url, name);
            if (!dlSuccess) {
              // Last resort: send URL to background
              chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", url: result.url, candidateName: name });
            }
          } else {
            // Nothing intercepted — check for PDF URL that appeared after click
            const postClickUrl = extractPdfUrl();
            if (postClickUrl) {
              log(`  Step 3: Found PDF URL after click, fetching…`);
              dlSuccess = await downloadViaFetch(postClickUrl, name);
              if (!dlSuccess) {
                chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME", url: postClickUrl, candidateName: name });
              }
            } else {
              log("  Step 3: Relying on background tab watcher (last resort)");
            }
          }
        }

        downloaded++;
        log(`  ✓ Downloaded: ${name}`);
        notify("PROGRESS", { downloaded, total, failed, candidateName: name });

        log("  Step 4: Closing popup…");
        await rsleep(800);
        await closePreviewPopup();
        await rsleep(500);
      } catch (err) {
        log(`  ✗ Error: ${err.message}`); failed++;
        notify("DOWNLOAD_ERROR", { candidateName: name, error: err.message });
        notify("PROGRESS", { downloaded, total, failed });
        await closePreviewPopup(); await rsleep(300);
      }

      if (i < applicantCards.length - 1 && !stopRequested) {
        const d = Math.random() * 5;
        log(`  ⏳ Waiting ${d.toFixed(1)}s…`);
        await randomDelay(0, 5);
      }
    }

    log(`\n✅ Done! Downloaded: ${downloaded}, Failed: ${failed}`);
    notify("DONE", { downloaded, total, failed });
    chrome.runtime.sendMessage({ type: "DOWNLOAD_STOPPED" }).catch(() => {});
  }

  // ══════════════════════════════════════════════════════════
  //  DEBUG SCAN — dumps actual DOM structure
  // ══════════════════════════════════════════════════════════

  function debugScan() {
    const info = { url: window.location.href };

    // Run scan
    const count = scanApplicantCards();
    info.applicantCardsFound = count;
    info.applicantNames = applicantCards.map((c) => c.name);

    // Resume / Download buttons
    info.resumeButtonVisible = !!document.querySelector('button[data-view-name="hiring-applicant-view-resume"]');
    info.documentIconVisible = !!document.querySelector('svg[id="document-small"]');
    info.downloadIconVisible = !!document.querySelector('svg[id="download-small"]');

    // All data-view-name elements
    info.dataViewElements = [];
    document.querySelectorAll("[data-view-name]").forEach((el) => {
      info.dataViewElements.push({
        tag: el.tagName,
        dataViewName: el.getAttribute("data-view-name"),
        text: el.textContent.trim().substring(0, 50),
      });
    });

    // Buttons with resume/download
    info.relevantButtons = [];
    document.querySelectorAll("button").forEach((btn) => {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes("resume") || text.includes("download")) {
        info.relevantButtons.push({
          text: btn.textContent.trim().substring(0, 60),
          dataViewName: btn.getAttribute("data-view-name") || "",
        });
      }
    });

    // ── DOM DUMP — show the actual structure of the left panel ──
    // Find elements that contain "Shortlist" or "Applicants"
    info.domHints = [];
    const body = document.body;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const t = textNode.textContent.trim();
      if (t === "Shortlist" || t === "Applicants" || t === "All applicants") {
        let parent = textNode.parentElement;
        // Walk up a few levels to find the container
        for (let i = 0; i < 6 && parent; i++) {
          parent = parent.parentElement;
        }
        if (parent) {
          info.domHints.push({
            heading: t,
            containerTag: parent.tagName,
            containerChildren: parent.children.length,
            firstChildTag: parent.children[0]?.tagName || "none",
            firstChildText: parent.children[0]?.textContent?.trim()?.substring(0, 100) || "none",
            firstChildDataView: parent.children[0]?.getAttribute?.("data-view-name") || "",
            firstChildComponentKey: parent.children[0]?.getAttribute?.("componentkey") || "",
            containerHTML: parent.outerHTML.substring(0, 300),
          });
        }
        break;
      }
    }

    // ── List all componentkey elements with their text ──
    info.componentKeyElements = [];
    document.querySelectorAll("[componentkey]").forEach((el) => {
      const text = el.textContent.trim();
      if (text.length > 15 && text.length < 500) {
        info.componentKeyElements.push({
          tag: el.tagName,
          key: el.getAttribute("componentkey")?.substring(0, 20) || "",
          textPreview: text.substring(0, 80),
          childCount: el.children.length,
        });
      }
    });

    // ── Links with applicationId ──
    info.applicationLinks = [];
    document.querySelectorAll('a[href*="applicationId"], a[href*="applicant"]').forEach((a) => {
      info.applicationLinks.push({
        href: a.href.substring(0, 120),
        text: a.textContent.trim().substring(0, 60),
      });
    });

    return info;
  }

  // ── Messaging ───────────────────────────────────────────

  function notify(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  function messageHandler(msg, _sender, sendResponse) {
    switch (msg.action) {
      case "SCAN_RESUMES": sendResponse({ count: scanApplicantCards() }); break;
      case "DEBUG_SCAN": sendResponse({ debug: debugScan() }); break;
      case "START_DOWNLOAD": startBulkDownload(); sendResponse({ ok: true }); break;
      case "STOP_DOWNLOAD": stopRequested = true; sendResponse({ ok: true }); break;
      default: sendResponse({ ok: false });
    }
    return true;
  }

  chrome.runtime.onMessage.addListener(messageHandler);
  window.__lbrd_cleanup = () => chrome.runtime.onMessage.removeListener(messageHandler);

  console.log("[LBRD] Content script v5 loaded.");
})();
