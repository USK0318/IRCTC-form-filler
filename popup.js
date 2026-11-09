/**
 * popup.js — profile management + "Fill Form" / "Clear Form" controller.
 *
 * Data flow: chrome.storage.local  ⇄  popup  →  (tabs.sendMessage)  →  content script.
 * Passenger data only travels from this popup to the IRCTC tab the user is
 * looking at. It is never logged and never leaves the browser.
 */
import {
  PASSENGER_TYPES, GENDERS, BERTHS, FOOD_CHOICES, NATIONALITIES, RESERVATION_CHOICES,
  INSURANCE_CHOICES, PAYMENT_CHOICES, LIMITS, GATEWAY_CATEGORIES, GATEWAY_OPTIONS,
  ensureDefaults, loadAll, savePassenger, deletePassenger, movePassenger, saveGroup, deleteGroup,
  saveSettings, saveSelection, clearAllData, validatePassenger, validateContact, validateCoachNumber, isInfantType,
} from "./storage.js";

const IRCTC_ORIGIN = "https://www.irctc.co.in/";
const BOOKING_RE = /^https:\/\/www\.irctc\.co\.in\/nget\/booking\/psgninput/i;
const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;

const $ = (sel) => document.querySelector(sel);
let state = { passengers: [], groups: [], settings: null, selection: null };
let pageInfo = { tabId: null, kind: "none", rows: null };
let busy = false;

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                     */
/* ------------------------------------------------------------------ */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function fillOptions(select, items) {
  select.replaceChildren(
    ...items.map((it) => (typeof it === "string" ? h("option", { value: it }, it) : h("option", { value: it.value }, it.label)))
  );
}

function radioList(container, name, items) {
  container.replaceChildren(
    ...items.map((it) =>
      h("label", { class: "check" }, h("input", { type: "radio", name, value: it.value }), h("span", {}, it.label))
    )
  );
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/** Two-click confirmation for destructive buttons (no blocking dialogs). */
function confirmClick(btn, label, action) {
  if (btn.dataset.confirming === "1") {
    delete btn.dataset.confirming;
    btn.classList.remove("confirming");
    action();
    return;
  }
  const original = btn.textContent;
  btn.dataset.confirming = "1";
  btn.classList.add("confirming");
  btn.textContent = label;
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.confirming === "1") {
      delete btn.dataset.confirming;
      btn.classList.remove("confirming");
      btn.textContent = original;
    }
  }, 3000);
}

function showErrors(form, errors) {
  form.querySelectorAll(".err").forEach((e) => (e.textContent = errors[e.dataset.for] || ""));
  form.querySelectorAll("[aria-invalid]").forEach((e) => e.removeAttribute("aria-invalid"));
  Object.keys(errors).forEach((k) => {
    const err = form.querySelector(`.err[data-for="${k}"]`);
    const input = err?.closest(".field")?.querySelector("input, select");
    if (input) input.setAttribute("aria-invalid", "true");
  });
}

const typeLabel = (t) => PASSENGER_TYPES.find((x) => x.value === t)?.label || "Passenger";
const initials = (name) => name.split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase() || "?";
function passengerMeta(p) {
  const parts = [`${p.age}y`, p.gender];
  if (p.type !== "infant_without_berth" && p.berth !== "No Preference") parts.push(p.berth);
  if (p.nationality && p.nationality !== "India") parts.push(p.nationality);
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
}

/* ------------------------------------------------------------------ */
/* Page detection / content-script messaging                            */
/* ------------------------------------------------------------------ */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function ping(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (_) {
    return null;
  }
}

/** Make sure our content script is in the tab (e.g. tab was open before install). */
async function ensureContentScript(tabId) {
  let res = await ping(tabId);
  if (res) return res;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  } catch (_) {
    return null;
  }
  return ping(tabId);
}

async function refreshPageStatus() {
  const el = $("#page-status");
  const tab = await activeTab();
  pageInfo = { tabId: tab?.id ?? null, kind: "none", rows: null };
  if (!tab || !tab.url || !tab.url.startsWith(IRCTC_ORIGIN)) {
    el.dataset.state = "none";
    el.textContent = "Open irctc.co.in to use Fill Form";
  } else if (!BOOKING_RE.test(tab.url)) {
    pageInfo.kind = "wrong";
    el.dataset.state = "wrong";
    el.textContent = "IRCTC open — go to the Passenger Details page";
  } else {
    pageInfo.kind = "booking";
    const res = await ensureContentScript(tab.id);
    if (!res) {
      el.dataset.state = "wrong";
      el.textContent = "Passenger page open — reload the tab once";
    } else {
      pageInfo.rows = res.rows;
      el.dataset.state = "ready";
      el.textContent = res.rows.adults
        ? `Passenger page detected · ${res.rows.adults} row${res.rows.adults > 1 ? "s" : ""} on page`
        : "Passenger page detected · waiting for form";
    }
  }
  updateActionButtons();
}

/* ------------------------------------------------------------------ */
/* BOOK tab                                                              */
/* ------------------------------------------------------------------ */

function selectedPassengers() {
  const byId = new Map(state.passengers.map((p) => [p.id, p]));
  if (state.selection.mode === "group") {
    const g = state.groups.find((x) => x.id === state.selection.groupId);
    return g ? g.passengerIds.map((id) => byId.get(id)).filter(Boolean) : [];
  }
  const chosen = new Set(state.selection.passengerIds);
  return state.passengers.filter((p) => chosen.has(p.id)); // saved order = row order
}

/** @returns {{ok:boolean, text:string}} */
function selectionCheck(list) {
  const adults = list.filter((p) => p.type !== "infant_without_berth").length;
  const infants = list.length - adults;
  if (!list.length) return { ok: false, text: "Select at least one passenger." };
  if (!adults) return { ok: false, text: "Infants without berth must travel with a passenger." };
  if (adults > LIMITS.MAX_PASSENGERS)
    return { ok: false, text: `IRCTC allows max ${LIMITS.MAX_PASSENGERS} passengers per ticket (4 for Tatkal). ${adults} selected.` };
  if (infants > LIMITS.MAX_INFANTS)
    return { ok: false, text: `IRCTC allows max ${LIMITS.MAX_INFANTS} infants without berth per ticket.` };
  const invalid = list.filter((p) => !validatePassenger(p).valid);
  if (invalid.length) return { ok: false, text: `Fix ${invalid.map((p) => p.name || "unnamed").join(", ")} in Passengers first.` };
  return {
    ok: true,
    text: `Will fill ${adults} passenger row${adults > 1 ? "s" : ""}${infants ? ` + ${infants} infant row${infants > 1 ? "s" : ""}` : ""}, in the order shown.`,
  };
}

function renderBook() {
  const mode = state.selection.mode;
  document.querySelectorAll('input[name="sel-mode"]').forEach((r) => (r.checked = r.value === mode));
  $("#sel-group-wrap").hidden = mode !== "group";

  const groupSel = $("#sel-group");
  fillOptions(groupSel, [{ value: "", label: state.groups.length ? "— Choose a group —" : "No groups yet (see Groups tab)" }, ...state.groups.map((g) => ({ value: g.id, label: `${g.name} (${g.passengerIds.length})` }))]);
  groupSel.value = state.selection.groupId || "";

  const list = $("#sel-list");
  list.replaceChildren();
  if (!state.passengers.length) {
    list.append(h("div", { class: "empty" }, "No saved passengers yet.", h("br"), h("button", { class: "btn small primary", onclick: () => { switchTab("passengers"); openPassengerForm(); } }, "+ Add Passenger")));
  } else if (mode === "group") {
    const members = selectedPassengers();
    members.forEach((p, i) =>
      list.append(h("div", { class: "check" }, h("span", { class: "order" }, String(i + 1)), h("span", {}, p.name, h("span", { class: "meta" }, passengerMeta(p)), isInfantType(p.type) ? h("span", { class: "badge" }, typeLabel(p.type)) : null)))
    );
  } else {
    const selected = selectedPassengers();
    state.passengers.forEach((p) => {
      const idx = selected.indexOf(p);
      list.append(
        h("label", { class: "check" },
          h("input", { type: "checkbox", checked: idx >= 0, dataset: { id: p.id }, onchange: onPickPassenger }),
          h("span", {},
            idx >= 0 ? h("span", { class: "order" }, String(idx + 1)) : null,
            p.name,
            h("span", { class: "meta" }, passengerMeta(p)),
            isInfantType(p.type) ? h("span", { class: "badge" }, typeLabel(p.type)) : null))
      );
    });
  }

  const check = selectionCheck(selectedPassengers());
  const sum = $("#sel-summary");
  sum.textContent = state.passengers.length ? check.text : "";
  sum.classList.toggle("bad", !check.ok && selectedPassengers().length > 0);
  updateActionButtons();
}

function updateActionButtons() {
  const onPage = pageInfo.kind === "booking";
  const check = selectionCheck(selectedPassengers());
  $("#btn-fill").disabled = busy || !onPage || !check.ok;
  $("#btn-clear").disabled = busy || !onPage;
  $("#btn-fill").title = !onPage ? "Open the IRCTC Passenger Details page first" : check.ok ? "" : check.text;
}

async function onPickPassenger(e) {
  const id = e.target.dataset.id;
  const ids = new Set(state.selection.passengerIds);
  e.target.checked ? ids.add(id) : ids.delete(id);
  state.selection.passengerIds = [...ids];
  await saveSelection(state.selection);
}

function renderResult(report, title) {
  const box = $("#result");
  box.hidden = false;
  $("#result-title").textContent = title;
  const pills = $("#result-pills");
  pills.replaceChildren();
  const s = report.summary || {};
  [["ok", "filled"], ["info", "notes"], ["warn", "check"], ["error", "failed"]].forEach(([k, label]) => {
    if (s[k]) pills.append(h("span", { class: `pill ${k}` }, `${s[k]} ${label}`));
  });
  const ul = $("#result-list");
  ul.replaceChildren();
  if (report.error) ul.append(h("li", {}, h("span", { class: "ic error" }, "✕"), h("div", {}, report.error)));
  const order = { error: 0, warn: 1, info: 2, ok: 3 };
  const icon = { ok: "✓", info: "i", warn: "!", error: "✕" };
  [...(report.items || [])]
    .sort((a, b) => order[a.status] - order[b.status])
    .forEach((it) =>
      ul.append(h("li", {}, h("span", { class: `ic ${it.status}` }, icon[it.status]), h("div", {}, h("b", {}, `${it.scope} · ${it.field}`), it.message ? h("div", { class: "msg" }, it.message) : null)))
    );
}

function buildPayload() {
  const s = state.settings;
  const coach = validateCoachNumber(s.preferences.coachNumber);
  return {
    passengers: selectedPassengers().map(({ type, name, age, gender, nationality, berth, food }) => ({ type, name, age, gender, nationality, berth, food })),
    contact: { ...s.contact },
    preferences: {
      autoUpgrade: !!s.preferences.autoUpgrade,
      confirmBerths: !!s.preferences.confirmBerths,
      reservationChoice: s.preferences.reservationChoice,
      coachNumber: coach.valid ? coach.value : "",
    },
    insurance: s.insurance,
    paymentMode: s.paymentMode,
  };
}

async function runOnPage(type) {
  await refreshPageStatus();
  if (pageInfo.kind !== "booking") {
    toast("Open the IRCTC Passenger Details page first.", "error");
    return;
  }
  const btn = type === "FILL" ? $("#btn-fill") : $("#btn-clear");
  const original = btn.textContent;
  busy = true;
  updateActionButtons();
  btn.textContent = type === "FILL" ? "Filling…" : "Clearing…";
  try {
    const res = await chrome.tabs.sendMessage(pageInfo.tabId, type === "FILL" ? { type, payload: buildPayload() } : { type });
    if (!res) throw new Error("no response");
    renderResult(res, type === "FILL" ? "Fill result" : "Clear result");
    const s = res.summary || {};
    if (res.error || s.error) toast(type === "FILL" ? "Filled with problems — see the list." : "Some fields could not be cleared.", "error");
    else toast(type === "FILL" ? "Form filled. Review it, then click Continue." : "Passenger fields cleared.", "ok");
  } catch (_) {
    renderResult({ items: [], summary: {}, error: "Lost contact with the IRCTC tab (it may have reloaded or navigated). Reopen this popup and try again." }, "Error");
  } finally {
    busy = false;
    btn.textContent = original;
    refreshPageStatus();
  }
}

/* ------------------------------------------------------------------ */
/* PASSENGERS tab                                                       */
/* ------------------------------------------------------------------ */

function renderPassengers() {
  const list = $("#passenger-list");
  list.replaceChildren();
  if (!state.passengers.length) {
    list.append(h("div", { class: "empty" }, "No passenger profiles yet. Add the people you usually travel with."));
    return;
  }
  state.passengers.forEach((p, i) => {
    const del = h("button", { class: "btn small danger-btn", title: "Delete Passenger" }, "Delete");
    del.addEventListener("click", () =>
      confirmClick(del, "Confirm?", async () => {
        await deletePassenger(p.id);
        toast("Passenger deleted.");
      })
    );
    list.append(
      h("div", { class: "item" },
        h("div", { class: "avatar" }, initials(p.name)),
        h("div", { class: "grow" },
          h("div", { class: "title" }, p.name),
          h("div", { class: "meta" }, passengerMeta(p), isInfantType(p.type) ? h("span", { class: "badge" }, typeLabel(p.type)) : null)),
        h("div", { class: "btns" },
          h("button", { class: "icon-btn", title: "Move up", "aria-label": "Move up", disabled: i === 0, onclick: () => movePassenger(p.id, -1) }, "▲"),
          h("button", { class: "icon-btn", title: "Move down", "aria-label": "Move down", disabled: i === state.passengers.length - 1, onclick: () => movePassenger(p.id, 1) }, "▼"),
          h("button", { class: "btn small ghost", title: "Edit Passenger", onclick: () => openPassengerForm(p) }, "Edit"),
          del))
    );
  });
}

function syncTypeFields() {
  const type = $("#pf-type").value;
  $("#pf-berth-food").hidden = type === "infant_without_berth";
  $("#pf-age").max = isInfantType(type) ? String(LIMITS.INFANT_AGE_MAX) : String(LIMITS.AGE_MAX);
}

function openPassengerForm(p = null) {
  const f = $("#passenger-form");
  f.hidden = false;
  $("#btn-add-passenger").hidden = true;
  $("#pf-title").textContent = p ? "Edit Passenger" : "Add Passenger";
  $("#pf-id").value = p?.id || "";
  $("#pf-type").value = p?.type || "passenger";
  $("#pf-name").value = p?.name || "";
  $("#pf-age").value = p?.age ?? "";
  $("#pf-gender").value = p?.gender || "";
  $("#pf-nationality").value = p?.nationality || "India";
  $("#pf-berth").value = p?.berth || "No Preference";
  $("#pf-food").value = p?.food || "No Preference";
  syncTypeFields();
  showErrors(f, {});
  f.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#pf-name").focus();
}

function closePassengerForm() {
  $("#passenger-form").hidden = true;
  $("#btn-add-passenger").hidden = false;
}

async function onSavePassenger(e) {
  e.preventDefault();
  const input = {
    id: $("#pf-id").value || undefined,
    type: $("#pf-type").value,
    name: $("#pf-name").value,
    age: $("#pf-age").value,
    gender: $("#pf-gender").value,
    nationality: $("#pf-nationality").value,
    berth: $("#pf-berth").value,
    food: $("#pf-food").value,
  };
  const res = await savePassenger(input);
  showErrors($("#passenger-form"), res.errors);
  if (!res.valid) return;
  // New passengers are pre-selected for the next booking.
  if (!input.id && !state.selection.passengerIds.includes(res.value.id)) {
    state.selection.passengerIds = [...state.selection.passengerIds, res.value.id];
    await saveSelection(state.selection);
  }
  closePassengerForm();
  toast(input.id ? "Profile updated." : "Profile saved.", "ok");
}

/* ------------------------------------------------------------------ */
/* GROUPS tab                                                           */
/* ------------------------------------------------------------------ */

function renderGroups() {
  const list = $("#group-list");
  list.replaceChildren();
  const byId = new Map(state.passengers.map((p) => [p.id, p]));
  if (!state.groups.length) {
    list.append(h("div", { class: "empty" }, "No groups yet."));
    return;
  }
  state.groups.forEach((g) => {
    const names = g.passengerIds.map((id) => byId.get(id)?.name).filter(Boolean);
    const del = h("button", { class: "btn small danger-btn" }, "Delete");
    del.addEventListener("click", () =>
      confirmClick(del, "Confirm?", async () => {
        await deleteGroup(g.id);
        toast("Group deleted.");
      })
    );
    list.append(
      h("div", { class: "item" },
        h("div", { class: "grow" },
          h("div", { class: "title" }, g.name),
          h("div", { class: "meta" }, names.length ? names.join(", ") : "No passengers (members were deleted)")),
        h("div", { class: "btns" },
          h("button", { class: "btn small ghost", onclick: () => { state.selection = { ...state.selection, mode: "group", groupId: g.id }; saveSelection(state.selection); switchTab("book"); } }, "Use"),
          h("button", { class: "btn small ghost", onclick: () => openGroupForm(g) }, "Edit"),
          del))
    );
  });
}

function openGroupForm(g = null) {
  if (!state.passengers.length) {
    toast("Add passengers first.", "error");
    switchTab("passengers");
    return;
  }
  const f = $("#group-form");
  f.hidden = false;
  $("#btn-add-group").hidden = true;
  $("#gf-title").textContent = g ? "Edit Group" : "New Group";
  $("#gf-id").value = g?.id || "";
  $("#gf-name").value = g?.name || "";
  const chosen = new Set(g?.passengerIds || []);
  // Existing order first, then the rest in saved order.
  const ordered = [
    ...(g?.passengerIds || []).map((id) => state.passengers.find((p) => p.id === id)).filter(Boolean),
    ...state.passengers.filter((p) => !chosen.has(p.id)),
  ];
  $("#gf-members").replaceChildren(
    ...ordered.map((p) =>
      h("label", { class: "check" },
        h("input", { type: "checkbox", value: p.id, checked: chosen.has(p.id) }),
        h("span", {}, p.name, h("span", { class: "meta" }, passengerMeta(p)), isInfantType(p.type) ? h("span", { class: "badge" }, typeLabel(p.type)) : null))
    )
  );
  showErrors(f, {});
  $("#gf-name").focus();
}

function closeGroupForm() {
  $("#group-form").hidden = true;
  $("#btn-add-group").hidden = false;
}

async function onSaveGroup(e) {
  e.preventDefault();
  const passengerIds = [...document.querySelectorAll("#gf-members input:checked")].map((i) => i.value);
  const res = await saveGroup({ id: $("#gf-id").value || undefined, name: $("#gf-name").value, passengerIds });
  showErrors($("#group-form"), res.errors);
  if (!res.valid) return;
  closeGroupForm();
  toast("Group saved.", "ok");
}

/* ------------------------------------------------------------------ */
/* SETTINGS tab                                                         */
/* ------------------------------------------------------------------ */

function renderSettings() {
  const s = state.settings;
  $("#st-mobile").value = s.contact.mobile;
  $("#st-email").value = s.contact.email;
  $("#st-overwrite").checked = !!s.contact.overwriteExisting;
  $("#st-autoupgrade").checked = !!s.preferences.autoUpgrade;
  $("#st-confirm").checked = !!s.preferences.confirmBerths;
  $("#st-reservation").value = s.preferences.reservationChoice;
  $("#st-coach").value = s.preferences.coachNumber;
  document.querySelectorAll('input[name="insurance"]').forEach((r) => (r.checked = r.value === s.insurance));
  document.querySelectorAll('input[name="payment"]').forEach((r) => (r.checked = r.value === s.paymentMode));
  $("#st-autopanel").checked = s.ui?.autoShowPanel !== false;
  $("#st-autocontinue").checked = !!s.autoFlow.continueAfterFill;
  $("#st-gateway").checked = !!s.autoFlow.selectGateway;
  $("#st-gw-category").value = s.autoFlow.gatewayCategory;
  $("#st-gw-option").value = s.autoFlow.gatewayOption;
  $("#st-paybook").checked = !!s.autoFlow.clickPayBook;
  $("#st-paybook-delay").value = s.autoFlow.payBookDelaySec ?? 5;
  syncPayBook();
}

function syncPayBook() {
  const gw = $("#st-gateway").checked;
  $("#st-paybook").disabled = !gw;
  if (!gw) $("#st-paybook").checked = false;
  $("#st-paybook-delay-wrap").hidden = !$("#st-paybook").checked;
}

async function onSaveSettings(e) {
  e.preventDefault();
  const contact = validateContact({
    mobile: $("#st-mobile").value,
    email: $("#st-email").value,
    overwriteExisting: $("#st-overwrite").checked,
  });
  const coach = validateCoachNumber($("#st-coach").value);
  const errors = { ...contact.errors, ...(coach.valid ? {} : { coach: coach.error }) };
  showErrors($("#settings-form"), errors);
  if (Object.keys(errors).length) {
    toast("Fix the highlighted fields.", "error");
    return;
  }
  await saveSettings({
    contact: contact.value,
    preferences: {
      autoUpgrade: $("#st-autoupgrade").checked,
      confirmBerths: $("#st-confirm").checked,
      reservationChoice: $("#st-reservation").value,
      coachNumber: coach.value,
    },
    insurance: document.querySelector('input[name="insurance"]:checked')?.value || "skip",
    paymentMode: document.querySelector('input[name="payment"]:checked')?.value || "skip",
    ui: { autoShowPanel: $("#st-autopanel").checked },
    autoFlow: {
      continueAfterFill: $("#st-autocontinue").checked,
      selectGateway: $("#st-gateway").checked,
      gatewayCategory: $("#st-gw-category").value,
      gatewayOption: $("#st-gw-option").value.trim() || "Paytm UPI",
      clickPayBook: $("#st-gateway").checked && $("#st-paybook").checked,
      payBookDelaySec: Math.max(0, Math.min(30, parseInt($("#st-paybook-delay").value, 10) || 0)),
    },
  });
  toast("Settings saved.", "ok");
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderBook();
  renderPassengers();
  renderGroups();
}

async function reload() {
  state = await loadAll();
  // Drop selections that point at deleted passengers/groups.
  const ids = new Set(state.passengers.map((p) => p.id));
  state.selection.passengerIds = state.selection.passengerIds.filter((id) => ids.has(id));
  if (state.selection.groupId && !state.groups.some((g) => g.id === state.selection.groupId)) state.selection.groupId = "";
  renderAll();
}

function bindStatic() {
  fillOptions($("#pf-type"), PASSENGER_TYPES);
  fillOptions($("#pf-gender"), [{ value: "", label: "Select" }, ...GENDERS.map((g) => ({ value: g, label: g }))]);
  fillOptions($("#pf-berth"), BERTHS);
  fillOptions($("#pf-food"), FOOD_CHOICES);
  $("#nationality-list").replaceChildren(...NATIONALITIES.map((n) => h("option", { value: n })));
  fillOptions($("#st-reservation"), RESERVATION_CHOICES);
  radioList($("#st-insurance"), "insurance", INSURANCE_CHOICES);
  radioList($("#st-payment"), "payment", PAYMENT_CHOICES);
  fillOptions($("#st-gw-category"), GATEWAY_CATEGORIES);
  $("#gw-option-list").replaceChildren(...GATEWAY_OPTIONS.map((n) => h("option", { value: n })));

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  document.querySelectorAll('input[name="sel-mode"]').forEach((r) =>
    r.addEventListener("change", async () => {
      state.selection.mode = r.value;
      await saveSelection(state.selection);
    })
  );
  $("#sel-group").addEventListener("change", async (e) => {
    state.selection.groupId = e.target.value;
    await saveSelection(state.selection);
  });
  $("#btn-fill").addEventListener("click", () => runOnPage("FILL"));
  $("#btn-clear").addEventListener("click", () => runOnPage("CLEAR"));

  $("#btn-add-passenger").addEventListener("click", () => openPassengerForm());
  $("#pf-cancel").addEventListener("click", closePassengerForm);
  $("#pf-type").addEventListener("change", syncTypeFields);
  // An infant type with an age of 5+ is almost always a mis-pick: switch to Passenger.
  $("#pf-age").addEventListener("input", () => {
    const age = Number($("#pf-age").value);
    if (isInfantType($("#pf-type").value) && Number.isInteger(age) && age > LIMITS.INFANT_AGE_MAX) {
      $("#pf-type").value = "passenger";
      syncTypeFields();
      toast(`Age ${age} is not an infant — Type switched to Passenger.`);
    }
  });
  $("#passenger-form").addEventListener("submit", onSavePassenger);

  $("#btn-add-group").addEventListener("click", () => openGroupForm());
  $("#gf-cancel").addEventListener("click", closeGroupForm);
  $("#group-form").addEventListener("submit", onSaveGroup);

  $("#settings-form").addEventListener("submit", onSaveSettings);
  $("#st-gateway").addEventListener("change", syncPayBook);
  $("#st-paybook").addEventListener("change", syncPayBook);
  $("#btn-wipe").addEventListener("click", (e) =>
    confirmClick(e.currentTarget, "Click again to delete everything", async () => {
      await clearAllData();
      closePassengerForm();
      closeGroupForm();
      $("#result").hidden = true;
      toast("All saved data deleted.", "ok");
    })
  );

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    reload().then(() => {
      if (changes.settings) renderSettings();
    });
  });
}

(async function init() {
  bindStatic();
  await ensureDefaults();
  await reload();
  renderSettings();
  if (!state.passengers.length) switchTab("passengers");
  refreshPageStatus();
})();
