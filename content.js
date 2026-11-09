/**
 * content.js — entry point of the content script.
 *
 * Runs on https://www.irctc.co.in/nget/* (IRCTC is a single-page app, so we
 * must already be present when the user navigates into the passenger page).
 * It does nothing until the popup asks it to, and it only ever:
 *   - answers PING (is this the passenger page? how many rows?),
 *   - runs FILL / CLEAR on request,
 *   - tells the background worker when the route changes (for the badge).
 */
(function () {
  "use strict";
  const NS = globalThis.IRCTCSF;
  if (!NS || NS.__entryLoaded) return;
  NS.__entryLoaded = true;

  const VERSION = chrome.runtime.getManifest?.().version || "dev";

  function reportRoute() {
    try {
      chrome.runtime.sendMessage({ type: "PAGE_STATUS", onBookingPage: NS.isBookingPage() }).catch?.(() => {});
    } catch (_) {
      /* extension reloaded — this orphaned script just goes quiet */
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    if (msg.type === "PING") {
      const rows = NS.isBookingPage() ? NS.findPassengerRows() : { adults: [], infants: [] };
      sendResponse({
        ok: true,
        version: VERSION,
        onBookingPage: NS.isBookingPage(),
        busy: NS.fillState.busy,
        rows: { adults: rows.adults.length, infants: rows.infants.length },
      });
      return false;
    }

    if (msg.type === "FILL" || msg.type === "CLEAR") {
      if (!NS.isBookingPage()) {
        sendResponse({
          action: msg.type.toLowerCase(),
          items: [],
          summary: {},
          error: "Open the IRCTC Passenger Details page first.",
        });
        return false;
      }
      const run = msg.type === "FILL" ? NS.fill(msg.payload, NS.overlay.progress) : NS.clear(NS.overlay.progress);
      run
        .then((report) => {
          if (!report.busy) NS.overlay.showReport(report);
          sendResponse(report);
          if (msg.type === "FILL") NS.autoflow.afterFill(report);
        })
        .catch(() => sendResponse({ items: [], summary: {}, error: "Unexpected error in the page script." }));
      return true; // async response
    }

    return false;
  });

  /* -------- SPA route watching (Angular router uses pushState) -------- */
  // Open the panel once the passenger form has actually rendered.
  async function openPanelWhenReady() {
    await NS.waitFor(() => !NS.isBookingPage() || NS.findPassengerRows().adults.length > 0, { timeout: 20000 });
    if (NS.isBookingPage() && !NS.panel.isOpen()) NS.panel.autoShow();
  }

  let lastHref = location.href;
  let wasOnBooking = NS.isBookingPage();
  function onRoute() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const onBooking = NS.isBookingPage();
    if (!onBooking) {
      NS.cancel();
      if (NS.autoflow.isActive()) NS.autoflow.onRoute();
      else NS.panel.hide();
    } else if (!wasOnBooking) {
      NS.autoflow.cancel(); // back on Passenger Details: start fresh
      NS.panel.hide();
      openPanelWhenReady();
    }
    wasOnBooking = onBooking;
    reportRoute();
  }
  window.addEventListener("popstate", onRoute);
  window.addEventListener("hashchange", onRoute);
  setInterval(onRoute, 1000);
  reportRoute();
  if (wasOnBooking) openPanelWhenReady();
  else NS.autoflow.onRoute(); // page reloaded mid-flow (e.g. on Review Journey)
})();
