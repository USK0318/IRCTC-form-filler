/**
 * content/autoflow.js — optional "Fill → Continue → Continue → pick payment
 * method" chain, enabled in Settings → After filling.
 *
 *   Passenger Details : after a clean fill, click Continue.
 *   Review Journey    : click Continue — unless a CAPTCHA is shown, in which
 *                       case the user types it and clicks Continue themself.
 *   Payment           : click the configured method (e.g. "BHIM/ UPI/ USSD")
 *                       and option (e.g. "Paytm UPI"). STOPS THERE.
 *
 * Hard limits: never clicks "Pay & Book", never types into CAPTCHA/OTP fields,
 * never enters payment credentials. If anything looks unexpected it stops and
 * tells the user what to do next.
 *
 * Flow state lives in this tab's sessionStorage (no personal data — just the
 * next step and an expiry), so it survives IRCTC's SPA navigation and a reload.
 */
(function () {
  "use strict";
  const NS = (globalThis.IRCTCSF = globalThis.IRCTCSF || {});
  const { sleep, norm, isVisible, waitFor, textOf } = NS;

  const KEY = "irctcsf-flow";
  const TTL_MS = 15 * 60 * 1000;
  // IRCTC can take a long time between pages, especially at peak hours.
  const LEAVE_PASSENGER_MS = 180000;
  const PAGE_LOAD_MS = 180000;
  const OVERLAY_ID = "irctc-smart-filler-overlay";

  /* ----------------------------- flow state ---------------------------- */

  function getFlow() {
    try {
      const f = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (!f || Date.now() > f.until) return null;
      return f;
    } catch (_) {
      return null;
    }
  }
  function setFlow(step, extra = {}) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ step, until: Date.now() + TTL_MS, ...extra }));
    } catch (_) {}
  }
  function clearFlow() {
    try {
      sessionStorage.removeItem(KEY);
    } catch (_) {}
  }

  async function loadAutoSettings() {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      return {
        continueAfterFill: true,
        selectGateway: true,
        gatewayCategory: "BHIM/ UPI/ USSD",
        gatewayOption: "Paytm UPI",
        ...((settings && settings.autoFlow) || {}),
      };
    } catch (_) {
      return null;
    }
  }

  /* ------------------------------ helpers ------------------------------ */

  const compact = (s) => norm(s).replace(/[^a-z0-9]/g, "");
  const FORBIDDEN = /pay ?& ?book|paybook|make payment|pay now|book now/;

  function inOverlay(el) {
    return !!el.closest(`#${OVERLAY_ID}`);
  }

  /** Smallest visible element whose text contains `target` (compared without spaces/punctuation). */
  function findByCompactText(target, { selector = "a, button, li, label, span, div, p, [role=button], [role=tab]", maxLen = 80 } = {}) {
    const want = compact(target);
    if (!want) return null;
    let best = null;
    let bestLen = Infinity;
    for (const n of document.querySelectorAll(selector)) {
      if (inOverlay(n) || !isVisible(n)) continue;
      const raw = n.innerText || n.textContent || "";
      const c = compact(raw);
      if (!c.includes(want) || c.length > Math.max(maxLen, want.length + 40)) continue;
      if (c.length < bestLen) {
        best = n;
        bestLen = c.length;
      }
    }
    return best;
  }

  function isDisabled(b) {
    return !!(b.disabled || b.getAttribute("aria-disabled") === "true" || b.classList.contains("disabled"));
  }

  /** IRCTC's own Continue button (e.g. <button class="train_Search">Continue </button>). */
  function continueButton({ allowDisabled = false } = {}) {
    const cands = Array.from(
      document.querySelectorAll("button, input[type=submit], input[type=button], a.btn, a[role=button], [role=button]")
    ).filter((b) => {
      if (inOverlay(b) || !isVisible(b)) return false;
      if (!allowDisabled && isDisabled(b)) return false;
      const t = norm(b.innerText || b.value || b.textContent);
      return /^continue\b/.test(t) && t.length <= 25;
    });
    if (!cands.length) return null;
    // Prefer a real submit button, then the last one on the page (the form's footer button).
    return cands.find((b) => (b.type || "").toLowerCase() === "submit") || cands[cands.length - 1];
  }

  /** Visible IRCTC validation/error messages (toasts, inline errors). */
  function hasValidationError() {
    const sel = ".ui-toast-message-error, .p-toast-message-error, .ui-messages-error, .p-message-error, .alert-danger, .error-msg, .invalid-feedback";
    return Array.from(document.querySelectorAll(sel)).some((el) => !inOverlay(el) && isVisible(el) && textOf(el).length > 0);
  }

  /** Real-user-like click: scroll into view, pointer/mouse sequence, then a single click. */
  function clickLikeUser(el) {
    const t = norm(el.innerText || el.value || el.textContent);
    if (FORBIDDEN.test(t)) throw new Error("refused: payment-submitting control");
    try {
      el.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.focus?.({ preventScroll: true });
    try {
      el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click(); // the one and only "click" event
  }

  function captchaVisible() {
    return Array.from(document.querySelectorAll("input, img")).some((el) => {
      if (inOverlay(el) || !isVisible(el)) return false;
      const d = norm(
        [el.id, el.name, el.getAttribute("formcontrolname"), el.getAttribute("placeholder"), el.getAttribute("alt"), el.className]
          .filter(Boolean)
          .join(" ")
      );
      return /captcha/.test(d);
    });
  }

  /* --------------------- slow-page handling ---------------------- */

  const LOADER_SEL = [
    "#preloaders", ".preloader", ".loading", ".loader", ".spinner", ".my-loading",
    ".ui-blockui", ".p-blockui", "p-progressspinner", ".ui-progress-spinner", ".p-progress-spinner",
    "ngx-spinner", ".ngx-spinner-overlay", ".overlay-loader", "[class*='loading-overlay']",
  ].join(",");

  /** IRCTC shows a full-page spinner/overlay while it talks to the server. */
  function loaderVisible() {
    for (const el of document.querySelectorAll(LOADER_SEL)) {
      if (inOverlay(el) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      // Ignore tiny inline spinners; a blocking loader is big or fixed/absolute over the page.
      const pos = getComputedStyle(el).position;
      if (r.width * r.height > 20000 || pos === "fixed") return true;
    }
    return false;
  }

  /**
   * Wait until IRCTC's blocking spinner is gone, then pause briefly so Angular
   * finishes rendering. (We don't wait for the DOM to go quiet: IRCTC's rotating
   * header banner and clock never stop changing.)
   */
  async function waitForIdle({ timeout = 15000, quietMs = 600 } = {}) {
    await waitFor(() => !loaderVisible(), { timeout, interval: 200 });
    await sleep(quietMs);
  }

  /** waitFor() that keeps the panel updated so a slow IRCTC doesn't look like a hang. */
  async function waitWithProgress(predicate, totalMs, label) {
    const start = Date.now();
    const timer = setInterval(() => {
      const secs = Math.round((Date.now() - start) / 1000);
      NS.panel?.progressOnly(`${label} (${secs}s — IRCTC is still loading)`);
    }, 5000);
    try {
      return await waitFor(predicate, { timeout: totalMs, interval: 300 });
    } finally {
      clearInterval(timer);
    }
  }

  function safeClick(el) {
    clickLikeUser(el);
  }

  /* ------------------------------ pages -------------------------------- */

  const path = () => (location.pathname + location.hash).toLowerCase();

  function isReviewPage() {
    if (/reviewbooking|review-booking/.test(path())) return true;
    return /\/nget\/booking\//.test(path()) && !NS.isBookingPage() && !!continueButton() && !!findByCompactText("View Cancellation Policy");
  }

  function isPaymentPage() {
    if (/\/nget\/payment\//.test(path())) return true;
    return !!findByCompactText("Payment Methods", { selector: "h1,h2,h3,h4,div,span", maxLen: 30 }) &&
      Array.from(document.querySelectorAll("button")).some((b) => /pay ?& ?book/.test(norm(b.textContent)));
  }

  function tell(text, tone = "info") {
    NS.panel?.message(text, tone);
  }

  /* ------------------------------ steps -------------------------------- */

  /** Called after a fill. Clicks Continue only if nothing failed. */
  async function afterFill(report) {
    if (!report || report.action !== "fill" || report.busy) return;
    try {
      const cfg = await loadAutoSettings();
      if (!cfg) {
        tell("Couldn't read settings (extension was reloaded?). Refresh this page, or click Continue yourself.", "warn");
        return;
      }
      if (!cfg.continueAfterFill) return; // user turned it off; button reads "Fill Form"

      const s = report.summary || {};
      if (report.aborted || report.error || s.error || s.warn) {
        tell("Not continuing automatically: fix the items marked ! or ✕ above, then click Continue yourself.", "warn");
        return;
      }
      tell("Filled. Clicking Continue…", "progress");

      if (captchaVisible()) {
        setFlow("review");
        tell("A CAPTCHA is shown. Type it and click Continue yourself; I'll carry on from the next page.", "warn");
        return;
      }

      // Short pause so Angular validates the last field; only wait for a blocking spinner, briefly.
      await sleep(600);
      await waitFor(() => !loaderVisible(), { timeout: 8000, interval: 200 });

      const btn = await waitFor(() => continueButton({ allowDisabled: true }), { timeout: 5000 });
      if (!btn) {
        tell("Couldn't find the Continue button on this page. Click it yourself.", "warn");
        return;
      }
      if (isDisabled(btn)) {
        const enabled = await waitFor(() => (isDisabled(btn) ? null : btn), { timeout: 8000 });
        if (!enabled) {
          tell("Continue is greyed out: IRCTC thinks something is still missing. Check the form and click Continue yourself.", "warn");
          return;
        }
      }

      setFlow("review");
      clickLikeUser(btn); // exactly once — never re-submitted
      NS.panel?.progressOnly("Clicked Continue — waiting for Review Journey…");

      const moved = await waitWithProgress(() => !NS.isBookingPage(), LEAVE_PASSENGER_MS, "Clicked Continue — waiting for Review Journey…");
      if (!moved) {
        // Keep the flow: if the user fixes something and clicks Continue, we pick up on Review Journey.
        setFlow("review");
        tell(hasValidationError()
          ? "IRCTC is showing an error on this page. Fix it and click Continue yourself; I'll carry on from Review Journey."
          : "IRCTC is still on Passenger Details after 3 minutes. Check the page and click Continue yourself; I'll carry on from Review Journey.", "warn");
      }
    } catch (e) {
      tell(`Auto-continue stopped (${(e && e.message) || "unexpected error"}). Click Continue yourself.`, "error");
    }
  }

  async function handleReview(cfg) {
    tell("Review Journey: waiting for the page to finish loading…", "progress");
    const ready = await waitWithProgress(() => continueButton() || captchaVisible(), PAGE_LOAD_MS, "Review Journey: waiting for the page…");
    if (!ready) {
      tell("Couldn't find the Continue button on Review Journey. Click it yourself.", "warn");
      return;
    }
    // Fare/availability and the CAPTCHA can render after the button: wait for the page to settle.
    await waitForIdle({ timeout: 10000, quietMs: 1200 });
    if (!cfg.continueAfterFill || captchaVisible()) {
      setFlow("payment");
      tell(captchaVisible()
        ? "Type the CAPTCHA and click Continue yourself. The payment method is picked on the next page."
        : "Check the journey and click Continue yourself.", "warn");
      return;
    }
    const btn = continueButton();
    if (!btn) {
      setFlow("payment");
      tell("Couldn't find the Continue button on Review Journey. Click it yourself; I'll pick the payment method next.", "warn");
      return;
    }
    setFlow("payment");
    safeClick(btn);
    tell("Clicked Continue on Review Journey. Waiting for the Payment page…", "progress");
    const reached = await waitWithProgress(() => isPaymentPage(), PAGE_LOAD_MS, "Clicked Continue — waiting for the Payment page…");
    if (reached) await handlePayment(cfg);
    else tell("The Payment page hasn't loaded yet. If IRCTC shows an error, click Continue yourself; I'll still pick the payment method when it opens.", "warn");
  }

  async function handlePayment(cfg) {
    clearFlow(); // one attempt per booking
    if (!cfg.selectGateway) {
      tell("Payment page reached. Choose a payment method and click Pay & Book yourself.", "info");
      return;
    }
    tell(`Payment: selecting ${cfg.gatewayCategory} → ${cfg.gatewayOption}…`, "progress");

    const category = await waitWithProgress(() => findByCompactText(cfg.gatewayCategory), PAGE_LOAD_MS, "Payment: waiting for payment methods…");
    if (!category) {
      tell(`Couldn't find "${cfg.gatewayCategory}". Select the payment method yourself, then click Pay & Book.`, "warn");
      return;
    }
    await waitForIdle({ timeout: 8000 });
    safeClick(findByCompactText(cfg.gatewayCategory) || category);
    await sleep(500);

    if (!cfg.gatewayOption) {
      tell(`${cfg.gatewayCategory} selected. Check the total, then click Pay & Book yourself.`, "ok");
      return;
    }
    const option = await waitWithProgress(() => findByCompactText(cfg.gatewayOption, { maxLen: 40 }), 30000, `Payment: waiting for ${cfg.gatewayOption}…`);
    if (!option) {
      tell(`${cfg.gatewayCategory} selected, but "${cfg.gatewayOption}" isn't listed. Pick an option yourself, then click Pay & Book.`, "warn");
      return;
    }
    await waitForIdle({ timeout: 8000 });
    safeClick(findByCompactText(cfg.gatewayOption, { maxLen: 40 }) || option);
    await sleep(300);
    tell(`${cfg.gatewayCategory} → ${cfg.gatewayOption} selected. Check the total fare, then click Pay & Book yourself.`, "ok");
  }

  let running = false;
  /** Called on every route change / page load. */
  async function onRoute() {
    const flow = getFlow();
    if (!flow || running) return;
    if (NS.isBookingPage()) return; // still on (or back to) Passenger Details
    running = true;
    try {
      const cfg = await loadAutoSettings();
      if (!cfg) return;
      // Give the SPA time to render the new view before classifying it.
      const page = await waitWithProgress(
        () => (NS.isBookingPage() ? "back" : isPaymentPage() ? "payment" : isReviewPage() ? "review" : null),
        PAGE_LOAD_MS,
        "Waiting for the next IRCTC page…"
      );
      if (page === "review" && flow.step === "review") await handleReview(cfg);
      else if (page === "payment") await handlePayment(cfg);
      else if (page === "back") return;
      else if (!page) tell("This page didn't look like Review Journey or Payment. Continue manually from here.", "warn");
    } catch (_) {
      clearFlow();
      tell("Stopped the automatic steps. Continue manually from here.", "warn");
    } finally {
      running = false;
    }
  }

  function isActive() {
    return !!getFlow();
  }

  NS.autoflow = { afterFill, onRoute, isActive, cancel: clearFlow, isReviewPage, isPaymentPage };
})();
