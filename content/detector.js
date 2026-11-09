/**
 * content/detector.js — finds IRCTC form controls by meaning, not by selector.
 *
 * Strategy, in order of preference for every field:
 *   1. semantic attributes (formcontrolname / name / id / placeholder / aria-*),
 *   2. the visible label text a user reads,
 *   3. the *content* of the control (e.g. a <select> whose options are
 *      Male/Female/Transgender is the gender control, wherever it lives).
 *
 * Passenger rows are discovered by anchoring on each gender control and
 * climbing to the smallest container that also holds a name field, so it
 * keeps working if IRCTC renames components or reshuffles the grid.
 */
(function () {
  "use strict";
  const NS = (globalThis.IRCTCSF = globalThis.IRCTCSF || {});
  const { norm, hasWord, isVisible, isVisibleOrWrapped, isEditable, textOf, describe, labelTextFor, selectLikeOptionsText, closestMatching, byDocumentOrder } = NS;

  const EXCLUDE_ROOT = "#irctc-smart-filler-overlay";

  function inOverlay(el) {
    return !!el.closest(EXCLUDE_ROOT);
  }

  /* ------------------------- control inventories ----------------------- */

  /** Native selects (not PrimeNG's hidden helper selects) + PrimeNG dropdowns. */
  function selectLikes(root = document) {
    const out = [];
    root.querySelectorAll("select").forEach((s) => {
      if (inOverlay(s) || s.closest("p-dropdown, .ui-dropdown, .p-dropdown")) return;
      if (isVisible(s)) out.push(s);
    });
    root.querySelectorAll("p-dropdown").forEach((d) => {
      if (isVisible(d) || isVisible(d.querySelector(".ui-dropdown, .p-dropdown"))) out.push(d);
    });
    root.querySelectorAll(".ui-dropdown, .p-dropdown").forEach((d) => {
      if (!d.closest("p-dropdown") && isVisible(d)) out.push(d);
    });
    return out.sort(byDocumentOrder);
  }

  function textInputs(root = document) {
    return Array.from(
      root.querySelectorAll(
        "input:not([type]), input[type=text], input[type=search], input[type=number], input[type=tel], input[type=email]"
      )
    ).filter((i) => !inOverlay(i) && isVisible(i));
  }

  /** Full description for a select-like: attributes + labels + option texts. */
  function selectProfile(ctrl) {
    let desc = describe(ctrl);
    if (!(ctrl instanceof HTMLSelectElement)) {
      const label = ctrl.querySelector(".ui-dropdown-label, .p-dropdown-label");
      if (label) desc += " " + textOf(label);
      const host = ctrl.closest("p-dropdown") || ctrl;
      ["placeholder", "formcontrolname", "name", "id"].forEach((a) => {
        const v = host.getAttribute(a);
        if (v) desc += " " + norm(v.replace(/([a-z])([A-Z])/g, "$1 $2"));
      });
    }
    const opts = selectLikeOptionsText(ctrl);
    return { desc: norm(desc), opts, optsJoined: opts.join(" | ") };
  }

  const anyOpt = (p, words) => words.some((w) => p.opts.some((o) => hasWord(o, w)));

  const KIND = {
    gender: (p) =>
      (anyOpt(p, ["male"]) && anyOpt(p, ["female"])) || /\bgender\b|\bsex\b/.test(p.desc),
    berth: (p) =>
      (anyOpt(p, ["lower"]) && anyOpt(p, ["upper"]) && !anyOpt(p, ["berths are allotted", "lower berth is allotted"])) ||
      /\bberth (choice|preference)\b|\bberth\b/.test(p.desc),
    nationality: (p) => anyOpt(p, ["india"]) || /nationality|country/.test(p.desc),
    food: (p) => anyOpt(p, ["veg", "non veg", "no food"]) || /\bfood\b|\bmeal\b|catering/.test(p.desc),
    infantAge: (p) =>
      anyOpt(p, ["below one year", "one year", "two years", "year", "years"]) || /\bage\b/.test(p.desc),
    reservationChoice: (p) =>
      /reservation ?choice/.test(p.desc) || anyOpt(p, ["same coach", "lower berth is allotted", "lower berths are allotted"]),
  };

  function classify(ctrl) {
    const p = selectProfile(ctrl);
    for (const k of ["reservationChoice", "gender", "berth", "food", "nationality"]) {
      if (KIND[k](p)) return k;
    }
    if (KIND.infantAge(p)) return "infantAge";
    return "unknown";
  }

  /* ---------------------------- name / age ----------------------------- */

  const NAME_EXCLUDE = /user|login|coach|email|e mail|mobile|phone|station|card|gst|address|city|state|pin|captcha|otp/;

  function isNameInput(i) {
    if (i.type === "number" || i.type === "tel" || i.type === "email") return false;
    const d = describe(i);
    if (NAME_EXCLUDE.test(d)) return false;
    return /\bname\b/.test(d) || !!i.closest("p-autocomplete");
  }

  function isAgeInput(i) {
    const d = describe(i);
    return /\bage\b/.test(d) && !/page|message|passage|stage|usage|image/.test(d.replace(/\bage\b/g, ""));
  }

  /* --------------------------- passenger rows -------------------------- */

  function rowTagHint(el) {
    return closestMatching(
      el,
      (n) => /^APP-.*(PASSENGER|INFANT)/.test(n.tagName) && !/LIST|DETAIL|INPUT$/.test(n.tagName),
      12
    );
  }

  /**
   * @returns {{adults: Row[], infants: Row[]}} in document order.
   * Row = {el, kind: 'adult'|'infant', name, age, gender, berth, nationality, food}
   */
  function findPassengerRows() {
    const genderCtrls = selectLikes().filter((c) => classify(c) === "gender");
    const seen = new Set();
    const rows = [];

    for (const g of genderCtrls) {
      const countGenders = (n) => genderCtrls.filter((x) => n.contains(x)).length;
      let el = rowTagHint(g);
      if (el && countGenders(el) !== 1) el = null;
      if (!el) {
        el = closestMatching(
          g.parentElement,
          (n) => countGenders(n) === 1 && textInputs(n).some(isNameInput),
          10
        );
      }
      if (!el) continue;
      // Never let one row swallow another row's gender control.
      if (countGenders(el) !== 1 || seen.has(el)) continue;
      seen.add(el);
      rows.push(describeRow(el, g));
    }
    rows.sort((a, b) => byDocumentOrder(a.el, b.el));
    return {
      adults: rows.filter((r) => r.kind === "adult"),
      infants: rows.filter((r) => r.kind === "infant"),
    };
  }

  function describeRow(el, genderCtrl) {
    const inputs = textInputs(el);
    const name = inputs.find((i) => isNameInput(i) && isEditable(i)) || null;
    const ageInput = inputs.find((i) => i !== name && isAgeInput(i)) || null;
    const selects = selectLikes(el).filter((c) => c !== genderCtrl);
    const pick = (kind) => selects.find((c) => classify(c) === kind) || null;
    const ageSelect = ageInput ? null : pick("infantAge");

    const tag = el.tagName;
    const hint = `${tag} ${name ? describe(name) : ""} ${ageInput ? describe(ageInput) : ""}`.toLowerCase();
    const isInfant = /infant/.test(hint) || (!!ageSelect && !ageInput);

    return {
      el,
      kind: isInfant ? "infant" : "adult",
      name,
      age: ageInput || ageSelect,
      gender: genderCtrl,
      berth: pick("berth"),
      nationality: pick("nationality"),
      food: pick("food"),
    };
  }

  /* --------------------------- add-row links --------------------------- */

  function clickableByText(test) {
    const nodes = document.querySelectorAll("a, button, [role=button], span, label, div, p");
    let best = null;
    let bestLen = Infinity;
    for (const n of nodes) {
      if (inOverlay(n) || !isVisible(n)) continue;
      const t = textOf(n);
      if (!t || t.length > 90 || !test(t)) continue;
      if (t.length < bestLen || (t.length === bestLen && best && best.contains(n))) {
        best = n;
        bestLen = t.length;
      }
    }
    if (!best) return null;
    return best.closest("a, button, [role=button]") || best;
  }

  function findAddPassengerTrigger() {
    return clickableByText((t) => /add passenger/.test(t) && !/without berth/.test(t));
  }

  function findAddInfantTrigger() {
    return clickableByText((t) => /add infant without berth/.test(t) || /^\+?\s*add infant$/.test(t));
  }

  /* ----------------------------- contact ------------------------------- */

  function outsideRows(el, rows) {
    return !rows.some((r) => r.el.contains(el));
  }

  function findContactFields(rows = []) {
    const inputs = textInputs().filter((i) => outsideRows(i, rows));
    const mobile = inputs.find((i) => /mobile|phone/.test(describe(i)) && !/otp/.test(describe(i))) || null;
    const email = inputs.find((i) => i.type === "email" || /\be ?mail\b/.test(describe(i))) || null;
    return { mobile, email };
  }

  /* ------------------------- checkboxes & radios ----------------------- */

  function controlText(ctrl) {
    let t = ctrl instanceof HTMLInputElement ? labelTextFor(ctrl) : "";
    if (!(ctrl instanceof HTMLInputElement)) {
      const parts = [ctrl.getAttribute("label") || "", ctrl.getAttribute("aria-label") || ""];
      const inner = ctrl.querySelector("label");
      if (inner) parts.push(inner.textContent);
      const innerInput = ctrl.querySelector("input");
      if (innerInput) parts.push(labelTextFor(innerInput));
      const sib = ctrl.nextElementSibling;
      if (sib && !sib.matches("input, select, p-checkbox, p-radiobutton")) parts.push(sib.textContent);
      t = norm(parts.join(" "));
    }
    if (!t) {
      // Fall back to the nearest parent that has text but only this one control.
      const kind = ctrl instanceof HTMLInputElement ? ctrl.type : ctrl.tagName.toLowerCase();
      const container = closestMatching(
        ctrl.parentElement,
        (n) => textOf(n).length > 0,
        3
      );
      if (container) {
        const others = container.querySelectorAll(
          kind === "radio" || kind === "p-radiobutton" ? "input[type=radio], p-radiobutton" : "input[type=checkbox], p-checkbox"
        );
        if (others.length <= 1 && textOf(container).length < 220) t = textOf(container);
      }
    }
    return t;
  }

  function checkboxes() {
    const out = [];
    document.querySelectorAll("p-checkbox, [role=checkbox]").forEach((c) => {
      if (!inOverlay(c) && isVisibleOrWrapped(c.querySelector("input") || c)) out.push(c);
    });
    document.querySelectorAll("input[type=checkbox]").forEach((c) => {
      if (inOverlay(c) || c.closest("p-checkbox, [role=checkbox]")) return;
      if (isVisibleOrWrapped(c) || (c.id && document.querySelector(`label[for="${CSS.escape(c.id)}"]`))) out.push(c);
    });
    return out.map((ctrl) => ({ ctrl, text: controlText(ctrl) }));
  }

  function radios() {
    const out = [];
    document.querySelectorAll("p-radiobutton, [role=radio]").forEach((r) => {
      if (inOverlay(r) || (r.matches("[role=radio]") && r.closest("p-radiobutton"))) return;
      if (isVisibleOrWrapped(r.querySelector("input") || r)) out.push(r);
    });
    document.querySelectorAll("input[type=radio]").forEach((r) => {
      if (inOverlay(r) || r.closest("p-radiobutton, [role=radio]")) return;
      if (isVisibleOrWrapped(r) || (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`))) out.push(r);
    });
    return out.map((ctrl) => {
      const input = ctrl instanceof HTMLInputElement ? ctrl : ctrl.querySelector("input");
      const group = norm(
        [ctrl.getAttribute("name"), ctrl.getAttribute("formcontrolname"), input?.name, input?.getAttribute("formcontrolname")]
          .filter(Boolean)
          .join(" ")
      );
      return { ctrl, text: controlText(ctrl), group, value: input?.value ?? ctrl.getAttribute("value") ?? "" };
    });
  }

  function findCheckbox(regex) {
    const hit = checkboxes().find((c) => regex.test(c.text));
    return hit ? hit.ctrl : null;
  }

  /** Radios inside the section whose heading matches `headingRe`. */
  function radiosInSection(headingRe, all) {
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,legend,label,span,div,p,strong,b"))
      .filter((n) => !inOverlay(n) && isVisible(n))
      .filter((n) => {
        const t = textOf(n);
        return t.length < 80 && headingRe.test(t);
      })
      .sort((a, b) => textOf(a).length - textOf(b).length)[0];
    if (!heading) return [];
    const section = closestMatching(
      heading,
      (n) => all.filter((r) => n.contains(r.ctrl)).length >= 2,
      6
    );
    return section ? all.filter((r) => section.contains(r.ctrl)) : [];
  }

  function findInsuranceRadios() {
    const all = radios();
    let list = all.filter((r) => /insur/.test(r.group) || /travel insurance/.test(r.text));
    if (list.length < 2) list = radiosInSection(/travel insurance/, all);
    return list;
  }

  function findPaymentRadios() {
    const all = radios();
    let list = all.filter(
      (r) => /payment|pay ?type|paymode/.test(r.group) || /bhim|\bupi\b|credit|debit|net ?banking/.test(r.text)
    );
    if (list.length < 2) list = radiosInSection(/payment mode|payment option|payment/, all);
    return list;
  }

  /* ----------------------- preferences: selects ------------------------ */

  function findReservationChoice(rows = []) {
    const list = selectLikes().filter((c) => outsideRows(c, rows));
    const direct = list.find((c) => classify(c) === "reservationChoice");
    if (direct) return direct;
    // Label near a select-like
    const label = Array.from(document.querySelectorAll("label, span, div, p"))
      .filter((n) => !inOverlay(n) && isVisible(n) && textOf(n).length < 40 && /reservation choice/.test(textOf(n)))[0];
    if (!label) return null;
    const box = closestMatching(label, (n) => list.some((c) => n.contains(c)), 4);
    return box ? list.find((c) => box.contains(c)) : null;
  }

  function findCoachInput(rows = []) {
    return (
      textInputs()
        .filter((i) => outsideRows(i, rows))
        .find((i) => /\bcoach\b/.test(describe(i)) && isEditable(i)) || null
    );
  }

  function isBookingPage() {
    return /\/nget\/booking\/psgninput/i.test(location.pathname + location.hash);
  }

  Object.assign(NS, {
    selectLikes,
    classify,
    findPassengerRows,
    findAddPassengerTrigger,
    findAddInfantTrigger,
    findContactFields,
    findCheckbox,
    findInsuranceRadios,
    findPaymentRadios,
    findReservationChoice,
    findCoachInput,
    isBookingPage,
  });
})();
