/**
 * content/panel.js — the floating "IRCTC Smart Filler" panel that opens by
 * itself on the Passenger Details page.
 *
 * Chrome does not let an extension pop its toolbar popup open on page load,
 * so the same controls (pick passengers / group → Fill Form / Clear Form) are
 * rendered inside the page, in a closed Shadow DOM so IRCTC's CSS and scripts
 * can't style or read it. It also shows progress and the per-field report,
 * including for fills started from the toolbar popup.
 *
 * Profiles are still managed in the toolbar popup; the panel reads the same
 * chrome.storage.local data and stays in sync with it.
 */
(function () {
  "use strict";
  const NS = (globalThis.IRCTCSF = globalThis.IRCTCSF || {});
  const HOST_ID = "irctc-smart-filler-overlay"; // detector.js ignores this subtree

  const LIMITS = { MAX_PASSENGERS: 6, MAX_INFANTS: 2 };
  const ICON = { ok: "✓", info: "i", warn: "!", error: "✕" };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card { position: fixed; right: 16px; top: 96px; z-index: 2147483646; width: 310px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 120px); display: flex; flex-direction: column;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2328;
      background: #fbf8f5; border: 1px solid #f1d9c6; border-radius: 14px; box-shadow: 0 12px 32px rgba(0,0,0,.2); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #fff; border-bottom: 1px solid #f1e4da; cursor: default; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #f26b1d; flex: none; }
    .title { font-weight: 700; flex: 1; font-size: 14px; }
    .hbtn { all: unset; cursor: pointer; padding: 2px 7px; border-radius: 6px; color: #6b5a4e; font-size: 14px; }
    .hbtn:hover { background: #fde4d3; }
    .body { padding: 10px 12px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
    .card.min { top: auto; bottom: 16px; width: auto; }
    .card.min .body { display: none; }
    .card.min .head { border-bottom: 0; cursor: pointer; }
    .seg { display: grid; grid-template-columns: 1fr 1fr; background: #f1e9e2; border-radius: 10px; padding: 3px; }
    .seg button { all: unset; text-align: center; padding: 5px; border-radius: 8px; cursor: pointer; font-weight: 600; color: #6e6a66; }
    .seg button.on { background: #fff; color: #d8560c; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
    select { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid #ddd2c8; border-radius: 9px; background: #fff; color: #1f2328; }
    .list { display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; background: #fff; border: 1px solid #eee3da; border-radius: 10px; padding: 4px; }
    .row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 8px; cursor: pointer; }
    .row:hover { background: #fbf3ed; }
    .row input { accent-color: #f26b1d; width: 15px; height: 15px; margin: 0; flex: none; }
    .num { display: inline-grid; place-items: center; min-width: 18px; height: 18px; border-radius: 50%; background: #f26b1d; color: #fff; font-size: 10.5px; font-weight: 700; flex: none; }
    .name { font-weight: 600; }
    .meta { color: #6e6a66; font-size: 12px; }
    .badge { font-size: 10.5px; font-weight: 600; padding: 0 6px; border-radius: 999px; background: #f4ede7; color: #7a5a44; }
    .hint { margin: 0; color: #6e6a66; font-size: 12px; }
    .hint.bad { color: #b42318; }
    .empty { text-align: center; color: #6e6a66; padding: 14px 8px; border: 1px dashed #e3d6cb; border-radius: 10px; background: #fff; }
    .actions { display: flex; gap: 8px; }
    .btn { all: unset; flex: 1; text-align: center; padding: 9px 10px; border-radius: 10px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
    .btn.primary { background: #f26b1d; color: #fff; }
    .btn.primary:hover { background: #d8560c; }
    .btn.ghost { background: #fff; border-color: #ddd2c8; }
    .btn.ghost:hover { background: #fff1e7; }
    .btn[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }
    .link { all: unset; color: #d8560c; cursor: pointer; font-weight: 600; font-size: 12px; }
    .link:hover { text-decoration: underline; }
    .status { background: #fff; border: 1px solid #eee3da; border-radius: 10px; padding: 8px 10px; }
    .status[hidden] { display: none; }
    .pills { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
    .pill { padding: 1px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; }
    .ok { background: #e6f6ec; color: #1a7f37; } .info { background: #eef3fb; color: #2f5f9e; }
    .warn { background: #fff4d6; color: #8a5a00; } .error { background: #fde8e8; color: #b42318; }
    ul { list-style: none; margin: 0; padding: 0; max-height: 220px; overflow-y: auto; }
    li { display: grid; grid-template-columns: 16px 1fr; gap: 6px; padding: 4px 0; border-top: 1px dashed #f1e4da; }
    li:first-child { border-top: 0; }
    .ic { font-weight: 700; text-align: center; background: none; }
    .ic.ok { color: #1a7f37; } .ic.info { color: #2f5f9e; } .ic.warn { color: #8a5a00; } .ic.error { color: #b42318; }
    .scope { font-weight: 600; } .msg { color: #57606a; font-size: 12px; }
    .note { margin-top: 8px; padding: 8px; border-radius: 8px; background: #fff1e7; color: #8a3b0c; font-weight: 500; font-size: 12px; }
    .spin { width: 12px; height: 12px; border: 2px solid #f6c7a6; border-top-color: #f26b1d; border-radius: 50%; animation: s .8s linear infinite; display: inline-block; vertical-align: -2px; margin-right: 6px; }
    @keyframes s { to { transform: rotate(360deg); } }
    .flow { padding: 9px 10px; border-radius: 10px; font-weight: 600; font-size: 12.5px; border: 1px solid transparent; }
    .flow.progress { background: #fff; border-color: #eee3da; color: #1f2328; font-weight: 500; }
    .flow.ok { background: #e6f6ec; color: #1a7f37; } .flow.info { background: #eef3fb; color: #2f5f9e; }
    .flow.warn { background: #fff4d6; color: #8a5a00; } .flow.error { background: #fde8e8; color: #b42318; }
  `;

  /* ------------------------------ state ------------------------------ */

  let root = null; // closed shadow root
  let data = { passengers: [], groups: [], settings: null, selection: { mode: "passengers", passengerIds: [], groupId: "" } };
  let minimized = false;
  let lastStatus = null; // {kind:'progress', text} | {kind:'report', report}
  let flowMsg = null; // {text, tone, action?} from autoflow.js

  /* ------------------------------ helpers ---------------------------- */

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  const isInfant = (t) => t === "infant_with_berth" || t === "infant_without_berth";
  const typeBadge = (t) => (t === "infant_without_berth" ? "Infant · no berth" : t === "infant_with_berth" ? "Infant · berth" : null);
  function meta(p) {
    const parts = [`${p.age}y`, p.gender];
    if (p.type !== "infant_without_berth" && p.berth && p.berth !== "No Preference") parts.push(p.berth);
    return parts.join(" · ");
  }

  async function loadData() {
    try {
      const d = await chrome.storage.local.get(["passengers", "groups", "settings", "selection"]);
      data = {
        passengers: Array.isArray(d.passengers) ? d.passengers : [],
        groups: Array.isArray(d.groups) ? d.groups : [],
        settings: d.settings || null,
        selection: { mode: "passengers", passengerIds: [], groupId: "", ...(d.selection || {}) },
      };
    } catch (_) {
      /* extension was reloaded; this orphaned script can't reach storage */
    }
  }

  function saveSelection() {
    try {
      chrome.storage.local.set({ selection: data.selection });
    } catch (_) {}
  }

  function selectedPassengers() {
    const byId = new Map(data.passengers.map((p) => [p.id, p]));
    if (data.selection.mode === "group") {
      const g = data.groups.find((x) => x.id === data.selection.groupId);
      return g ? g.passengerIds.map((id) => byId.get(id)).filter(Boolean) : [];
    }
    const chosen = new Set(data.selection.passengerIds);
    return data.passengers.filter((p) => chosen.has(p.id));
  }

  function selectionCheck(list) {
    const adults = list.filter((p) => p.type !== "infant_without_berth").length;
    const infants = list.length - adults;
    if (!list.length) return { ok: false, text: "Select at least one passenger." };
    if (!adults) return { ok: false, text: "Infants without berth must travel with a passenger." };
    if (adults > LIMITS.MAX_PASSENGERS) return { ok: false, text: `Max ${LIMITS.MAX_PASSENGERS} passengers per ticket (4 for Tatkal).` };
    if (infants > LIMITS.MAX_INFANTS) return { ok: false, text: `Max ${LIMITS.MAX_INFANTS} infants without berth per ticket.` };
    return { ok: true, text: `Fills ${adults} passenger row${adults > 1 ? "s" : ""}${infants ? ` + ${infants} infant row${infants > 1 ? "s" : ""}` : ""}.` };
  }

  function buildPayload() {
    const s = data.settings || {};
    const prefs = s.preferences || {};
    const coach = String(prefs.coachNumber || "").trim().toUpperCase();
    return {
      passengers: selectedPassengers().map(({ type, name, age, gender, nationality, berth, food }) => ({ type, name, age, gender, nationality, berth, food })),
      contact: { ...(s.contact || {}) },
      preferences: {
        autoUpgrade: prefs.autoUpgrade !== false,
        confirmBerths: !!prefs.confirmBerths,
        reservationChoice: prefs.reservationChoice || "skip",
        coachNumber: /^[A-Z0-9]{1,4}$/.test(coach) ? coach : "",
      },
      insurance: s.insurance || "skip",
      paymentMode: s.paymentMode || "skip",
    };
  }

  function openManager() {
    try {
      chrome.runtime.sendMessage({ type: "OPEN_POPUP" }).then((res) => {
        if (!res || !res.ok) showHint("Click the IRCTC Smart Filler icon in the Chrome toolbar to add or edit passengers.");
      }).catch(() => showHint("Click the IRCTC Smart Filler icon in the Chrome toolbar to add or edit passengers."));
    } catch (_) {
      showHint("Click the IRCTC Smart Filler icon in the Chrome toolbar to add or edit passengers.");
    }
  }

  function showHint(text) {
    const el = root?.querySelector(".mgr-hint");
    if (el) {
      el.textContent = text;
      el.hidden = false;
    }
  }

  /* ------------------------------ render ----------------------------- */

  function ensureHost() {
    if (root && document.getElementById(HOST_ID)) return root;
    document.getElementById(HOST_ID)?.remove();
    const host = document.createElement("div");
    host.id = HOST_ID;
    root = host.attachShadow({ mode: "closed" });
    root.append(h("style", {}, CSS));
    const card = h("div", { class: "card", role: "dialog", "aria-label": "IRCTC Smart Filler" });
    const head = h("div", { class: "head" },
      h("span", { class: "dot" }),
      h("span", { class: "title" }, "IRCTC Smart Filler"),
      h("button", { class: "hbtn min-btn", title: "Minimise", "aria-label": "Minimise", onclick: (e) => { e.stopPropagation(); setMin(!minimized); } }, "▁"),
      h("button", { class: "hbtn", title: "Close (re-opens next time you visit this page)", "aria-label": "Close", onclick: (e) => { e.stopPropagation(); hide(); } }, "✕"));
    head.addEventListener("click", () => minimized && setMin(false));
    card.append(head, h("div", { class: "body" }));
    root.append(card);
    document.documentElement.appendChild(host);
    return root;
  }

  function setMin(v) {
    minimized = v;
    root?.querySelector(".card")?.classList.toggle("min", v);
    const b = root?.querySelector(".min-btn");
    if (b) b.textContent = v ? "▢" : "▁";
  }

  function render() {
    if (!root) return;
    const body = root.querySelector(".body");
    body.replaceChildren();
    const busy = !!NS.fillState?.busy;

    // Review / Payment pages: only show what the automatic steps are doing.
    if (!NS.isBookingPage()) {
      renderFlow(body);
      return;
    }

    if (!data.passengers.length) {
      body.append(
        h("div", { class: "empty" }, "No saved passengers yet.", h("br"),
          h("button", { class: "link", onclick: openManager }, "Add passengers →")),
        h("p", { class: "hint mgr-hint", hidden: true })
      );
      renderStatus(body);
      return;
    }

    const mode = data.selection.mode;
    body.append(
      h("div", { class: "seg" },
        h("button", { class: mode === "passengers" ? "on" : "", onclick: () => { data.selection.mode = "passengers"; saveSelection(); render(); } }, "Passengers"),
        h("button", { class: mode === "group" ? "on" : "", onclick: () => { data.selection.mode = "group"; saveSelection(); render(); } }, "Group"))
    );

    if (mode === "group") {
      const sel = h("select", { "aria-label": "Saved group", onchange: (e) => { data.selection.groupId = e.target.value; saveSelection(); render(); } },
        h("option", { value: "" }, data.groups.length ? "— Choose a group —" : "No groups yet"),
        ...data.groups.map((g) => {
          const o = h("option", { value: g.id }, `${g.name} (${g.passengerIds.length})`);
          if (g.id === data.selection.groupId) o.selected = true;
          return o;
        }));
      body.append(sel);
      const members = selectedPassengers();
      if (members.length) {
        body.append(h("div", { class: "list" }, members.map((p, i) =>
          h("div", { class: "row" }, h("span", { class: "num" }, String(i + 1)),
            h("span", {}, h("span", { class: "name" }, p.name), " ", h("span", { class: "meta" }, meta(p)), " ", typeBadge(p.type) ? h("span", { class: "badge" }, typeBadge(p.type)) : null)))));
      }
    } else {
      const selected = selectedPassengers();
      body.append(h("div", { class: "list" }, data.passengers.map((p) => {
        const idx = selected.indexOf(p);
        return h("label", { class: "row" },
          h("input", { type: "checkbox", checked: idx >= 0, onchange: (e) => {
            const ids = new Set(data.selection.passengerIds);
            e.target.checked ? ids.add(p.id) : ids.delete(p.id);
            data.selection.passengerIds = [...ids];
            saveSelection();
            render();
          } }),
          idx >= 0 ? h("span", { class: "num" }, String(idx + 1)) : null,
          h("span", {}, h("span", { class: "name" }, p.name), " ", h("span", { class: "meta" }, meta(p)), " ", typeBadge(p.type) ? h("span", { class: "badge" }, typeBadge(p.type)) : null));
      })));
    }

    const check = selectionCheck(selectedPassengers());
    body.append(h("p", { class: `hint${check.ok || !selectedPassengers().length ? "" : " bad"}` }, check.text));

    const fillBtn = h("button", { class: "btn primary", "aria-disabled": String(busy || !check.ok), title: check.ok ? "" : check.text, onclick: () => !busy && check.ok && run("fill") }, busy ? "Working…" : autoContinue() ? "Fill & Continue" : "Fill Form");
    const clearBtn = h("button", { class: "btn ghost", "aria-disabled": String(busy), onclick: () => !busy && run("clear") }, "Clear Form");
    body.append(h("div", { class: "actions" }, fillBtn, clearBtn));
    body.append(h("div", {}, h("button", { class: "link", onclick: openManager }, "Manage passengers & settings"), h("p", { class: "hint mgr-hint", hidden: true })));
    renderStatus(body);
    renderFlow(body);
  }

  function autoContinue() {
    return data.settings?.autoFlow?.continueAfterFill !== false;
  }

  function renderFlow(body) {
    if (!flowMsg) return;
    const el = h("div", { class: `flow ${flowMsg.tone}` });
    if (flowMsg.tone === "progress") el.append(h("span", { class: "spin" }));
    el.append(flowMsg.text);
    if (flowMsg.action) {
      const act = flowMsg.action;
      el.append(h("div", { class: "actions", style: "margin-top:8px" },
        h("button", { class: "btn ghost", onclick: () => { act.onClick(); flowMsg = { text: "Cancelling…", tone: "info" }; render(); } }, act.label)));
    }
    body.append(el);
  }

  function renderStatus(body) {
    const box = h("div", { class: "status", hidden: !lastStatus });
    body.append(box);
    if (!lastStatus) return;
    if (lastStatus.kind === "progress") {
      box.append(h("div", {}, h("span", { class: "spin" }), lastStatus.text));
      return;
    }
    const report = lastStatus.report;
    const s = report.summary || {};
    const pills = h("div", { class: "pills" });
    [["ok", "filled"], ["info", "notes"], ["warn", "check"], ["error", "failed"]].forEach(([k, label]) => {
      if (s[k]) pills.append(h("span", { class: `pill ${k}` }, `${s[k]} ${label}`));
    });
    box.append(pills);
    const order = { error: 0, warn: 1, info: 2, ok: 3 };
    const ul = h("ul");
    if (report.error) ul.append(h("li", {}, h("span", { class: "ic error" }, ICON.error), h("div", {}, report.error)));
    [...(report.items || [])].sort((a, b) => order[a.status] - order[b.status]).forEach((it) =>
      ul.append(h("li", {}, h("span", { class: `ic ${it.status}` }, ICON[it.status]),
        h("div", {}, h("span", { class: "scope" }, `${it.scope} · ${it.field}`), it.message ? h("div", { class: "msg" }, it.message) : null))));
    box.append(ul);
    box.append(h("div", { class: "note" }, report.action === "clear"
      ? "Passenger fields cleared."
      : autoContinue()
        ? "If everything filled cleanly, Continue is clicked for you. Otherwise fix the items above and click Continue yourself."
        : "Review every field, complete anything marked above, then click Continue yourself."));
  }

  async function run(kind) {
    await loadData();
    flowMsg = null;
    const report = kind === "fill" ? await NS.fill(buildPayload(), progress) : await NS.clear(progress);
    if (!report.busy) showReport(report);
    else render();
    if (kind === "fill") NS.autoflow?.afterFill(report);
  }

  /* ------------------------- public interface ------------------------ */

  async function show() {
    ensureHost();
    await loadData();
    render();
  }

  function hide() {
    document.getElementById(HOST_ID)?.remove();
    root = null;
    lastStatus = null;
    flowMsg = null;
  }

  /** Step messages from autoflow.js (works on any IRCTC page). */
  async function message(text, tone = "info", action = null) {
    flowMsg = { text, tone, action };
    if (!root) {
      ensureHost();
      await loadData();
    }
    setMin(false);
    render();
  }

  function progress(text) {
    lastStatus = { kind: "progress", text };
    if (!root) ensureHost();
    setMin(false);
    render();
  }

  function showReport(report) {
    lastStatus = { kind: "report", report };
    if (!root) ensureHost();
    setMin(false);
    render();
  }

  /** Auto-open unless the user switched it off in Settings. */
  async function autoShow() {
    await loadData();
    if (data.settings?.ui?.autoShowPanel === false) return;
    show();
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !root) return;
      if (changes.passengers || changes.groups || changes.selection || changes.settings) {
        loadData().then(() => {
          if (data.settings?.ui?.autoShowPanel === false && !lastStatus) hide();
          else render();
        });
      }
    });
  } catch (_) {}

  NS.panel = { show, hide, autoShow, message, progressOnly: (t) => message(t, "progress"), isOpen: () => !!root };
  // Keep the old overlay API used by content.js for popup-started fills.
  NS.overlay = { progress, showReport, hide };
})();
