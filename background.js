/**
 * background.js — MV3 service worker.
 *
 * Responsibilities (deliberately small):
 *  - seed default storage on install/update;
 *  - show a "ready" badge on tabs that are on the IRCTC passenger page
 *    (the content script reports SPA route changes here).
 *
 * It never reads page content, never makes network requests and never sees
 * passenger data.
 */
import { ensureDefaults } from "./storage.js";

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaults().catch(() => {
    /* storage unavailable — popup will retry on open */
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // "Manage passengers & settings" link in the in-page panel.
  if (msg && msg.type === "OPEN_POPUP") {
    if (!chrome.action.openPopup) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.action
      .openPopup(sender.tab ? { windowId: sender.tab.windowId } : undefined)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!msg || msg.type !== "PAGE_STATUS" || !sender.tab || sender.tab.id == null) return;
  const tabId = sender.tab.id;
  const ready = !!msg.onBookingPage;
  chrome.action.setBadgeText({ tabId, text: ready ? "ON" : "" }).catch(() => {});
  if (ready) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#F26B1D" }).catch(() => {});
    chrome.action
      .setTitle({ tabId, title: "IRCTC Smart Filler — passenger page detected" })
      .catch(() => {});
  } else {
    chrome.action.setTitle({ tabId, title: "IRCTC Smart Filler" }).catch(() => {});
  }
});
