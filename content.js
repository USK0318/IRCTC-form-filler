/* IRCTC Form Filler — content script
 * Fills the IRCTC passenger booking form from the passenger list you saved in
 * the extension popup, then checks "Consider for Auto Upgradation", selects
 * "Pay through BHIM/UPI", and clicks Continue.
 *
 * The page is an Angular (nget) single-page app using PrimeNG components, so we
 * set values through the native setter + dispatch real events, click PrimeNG
 * checkboxes/radios rather than toggling hidden inputs, and watch for
 * client-side route changes.
 */
(function () {
  "use strict";

  if (window.__irctcFillerLoaded) return;
  window.__irctcFillerLoaded = true;

  const KEY = "iffPassengers";

  /* ---------------------------- utilities ---------------------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  function log(...args) {
    console.log("%c[IRCTC Filler]", "color:#e07a1f;font-weight:bold", ...args);
  }

  async function waitFor(predicate, { timeout = 8000, interval = 150 } = {}) {
    const start = Date.now();
    for (;;) {
      let val;
      try {
        val = predicate();
      } catch (_) {
        val = null;
      }
      if (val) return val;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = desc && desc.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function fireKey(el, type, key) {
    el.dispatchEvent(
      new KeyboardEvent(type, { key, bubbles: true, cancelable: true })
    );
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findByText(text, selector = "*") {
    const target = norm(text);
    for (const n of document.querySelectorAll(selector)) {
      const t = norm(n.textContent);
      if (t === target || t.includes(target)) return n;
    }
    return null;
  }

  // Select an <option> in a native <select> by matching visible text.
  function selectByText(select, wanted) {
    if (!select || !wanted) return false;
    const w = norm(wanted);
    let match = null;
    for (const opt of select.options) {
      const t = norm(opt.textContent);
      if (t === w) {
        match = opt;
        break;
      }
      if (!match && t.includes(w)) match = opt;
    }
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /* ---------------------------- form actions ------------------------- */

  function getNameInputs() {
    return Array.from(document.querySelectorAll("p-autocomplete input")).filter(
      isVisible
    );
  }

  function getAddPassengerLink() {
    for (const el of document.querySelectorAll("a, span, div, button")) {
      const t = norm(el.textContent);
      if (t.includes("add passenger") && !t.includes("infant") && el.children.length <= 2) {
        return el;
      }
    }
    return null;
  }

  async function ensurePassengerRows(count) {
    let guard = 0;
    while (getNameInputs().length < count && guard < count + 4) {
      const link = getAddPassengerLink();
      if (!link) break;
      link.click();
      guard++;
      await sleep(450);
    }
  }

  // Smallest ancestor of the name input that also contains a <select> — the
  // passenger row.
  function getRow(nameInput) {
    let el = nameInput;
    for (let i = 0; i < 8 && el; i++) {
      if (el.querySelector("select")) return el;
      el = el.parentElement;
    }
    return nameInput.parentElement;
  }

  function classifySelects(row) {
    const out = { gender: null, berth: null, country: null };
    for (const sel of row.querySelectorAll("select")) {
      const opts = Array.from(sel.options).map((o) => norm(o.textContent)).join("|");
      if (/male|female|transgender/.test(opts) && !out.gender) out.gender = sel;
      else if (/lower|upper|middle|side/.test(opts) && !out.berth) out.berth = sel;
      else if (/india|afghan|united/.test(opts) && !out.country) out.country = sel;
    }
    return out;
  }

  function getAgeInput(row, nameInput) {
    const byFc = row.querySelector('input[formcontrolname="passengerAge"]');
    if (byFc) return byFc;
    return (
      Array.from(row.querySelectorAll("input")).find(
        (i) => i !== nameInput && !i.closest("p-autocomplete") && isVisible(i)
      ) || null
    );
  }

  // Type the name into the PrimeNG autocomplete; if a saved-passenger suggestion
  // matches, pick it (harmless), otherwise keep the typed value.
  async function fillName(input, name) {
    input.focus();
    input.click();
    setNativeValue(input, name);
    fireKey(input, "keyup", name.slice(-1));

    const item = await waitFor(
      () => {
        const items = document.querySelectorAll(
          ".ui-autocomplete-panel li, .p-autocomplete-panel li, ul.ui-autocomplete-items li"
        );
        for (const li of items) {
          if (isVisible(li) && norm(li.textContent).includes(norm(name))) return li;
        }
        return null;
      },
      { timeout: 1500, interval: 120 }
    );
    if (item) {
      item.click();
      await sleep(250);
    }
  }

  async function fillPassengers(list) {
    await ensurePassengerRows(list.length);
    await sleep(300);

    const inputs = getNameInputs();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const nameInput = inputs[i];
      if (!nameInput) {
        log(`No name field for passenger ${i + 1}`);
        continue;
      }
      setStatus(`Filling ${i + 1}/${list.length}: ${p.name}`);
      await fillName(nameInput, p.name);

      const row = getRow(nameInput);
      const age = getAgeInput(row, nameInput);
      if (age && p.age) setNativeValue(age, String(p.age));

      const sels = classifySelects(row);
      if (sels.gender && p.gender) selectByText(sels.gender, p.gender);
      if (sels.country && p.nationality) selectByText(sels.country, p.nationality);
      if (sels.berth && p.berth) selectByText(sels.berth, p.berth);

      await sleep(250);
    }
  }

  function clickPrimeControlNear(labelText, boxSelector) {
    const label = findByText(labelText, "label, span, div");
    if (!label) return false;
    let scope = label;
    for (let up = 0; up < 4 && scope; up++) {
      const box = scope.querySelector(boxSelector);
      if (box && isVisible(box)) {
        box.click();
        return true;
      }
      scope = scope.parentElement;
    }
    return false;
  }

  // Select "Skip" in the "IRCTC Co-branded Card Benefits" radio group. Scoped
  // to that section so the short word "Skip" can't match elsewhere.
  function selectCoBrandedSkip() {
    // Find the section heading, then climb to a container holding radios.
    let heading = findByText("Co-branded Card Benefits", "label, span, div, h1, h2, h3, b, strong");
    let container = heading;
    for (let up = 0; up < 6 && container; up++) {
      if (container.querySelector(".ui-radiobutton-box, .p-radiobutton-box")) break;
      container = container.parentElement;
    }
    const scope = container || document;

    // Within the section, find the "Skip" label and click its radio.
    for (const el of scope.querySelectorAll("label, span, div")) {
      if (norm(el.textContent) === "skip") {
        let s = el;
        for (let up = 0; up < 4 && s; up++) {
          const box = s.querySelector(".ui-radiobutton-box, .p-radiobutton-box");
          if (box && isVisible(box)) {
            box.click();
            return true;
          }
          s = s.parentElement;
        }
      }
    }
    log("Could not find co-branded card 'Skip' option.");
    return false;
  }

  function checkAutoUpgradation() {
    if (!clickPrimeControlNear("Consider for Auto Upgradation", ".ui-chkbox-box, .p-checkbox-box")) {
      log("Could not find Auto Upgradation checkbox.");
      return false;
    }
    return true;
  }

  function selectBhimUpi() {
    if (clickPrimeControlNear("Pay through BHIM/UPI", ".ui-radiobutton-box, .p-radiobutton-box")) {
      return true;
    }
    const label = findByText("Pay through BHIM/UPI", "label, span, div");
    if (label) {
      label.click();
      return true;
    }
    log("Could not find BHIM/UPI option.");
    return false;
  }

  function clickContinue() {
    for (const b of document.querySelectorAll("button, input[type=submit]")) {
      if (norm(b.textContent) === "continue" || norm(b.value) === "continue") {
        b.click();
        return true;
      }
    }
    log("Could not find Continue button.");
    return false;
  }

  /* ---------------------------- orchestration ------------------------ */

  async function runFill(list, opts) {
    await fillPassengers(list);

    if (opts.coBrandSkip) {
      setStatus("Selecting Co-branded card 'Skip'…");
      selectCoBrandedSkip();
      await sleep(300);
    }
    if (opts.autoUpgrade) {
      setStatus("Enabling Auto Upgradation…");
      checkAutoUpgradation();
      await sleep(300);
    }
    if (opts.bhimUpi) {
      setStatus("Selecting BHIM/UPI…");
      selectBhimUpi();
      await sleep(300);
    }
    if (opts.clickContinue) {
      setStatus("Clicking Continue…");
      await sleep(300);
      clickContinue();
    }
    setStatus("Done ✓");
  }

  /* ------------------------------- UI -------------------------------- */

  let statusEl;
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
    log(msg);
  }

  function getSaved(cb) {
    try {
      chrome.storage.local.get([KEY, "iffOpts"], (data) => {
        cb(Array.isArray(data[KEY]) ? data[KEY] : [], data.iffOpts || null);
      });
    } catch (_) {
      cb([], null);
    }
  }

  function buildPanel() {
    if (document.getElementById("irctc-filler-panel")) return;

    const panel = document.createElement("div");
    panel.id = "irctc-filler-panel";
    panel.innerHTML = `
      <div class="iff-head">
        <span class="iff-title">IRCTC Form Filler</span>
        <button class="iff-min" title="Minimize">–</button>
      </div>
      <div class="iff-body">
        <div class="iff-label">Select passengers to fill</div>
        <div id="iff-list" class="iff-list"></div>
        <div class="iff-opts">
          <label><input type="checkbox" id="iff-cobrand" checked /> Skip Co-branded card</label>
          <label><input type="checkbox" id="iff-upgrade" checked /> Auto Upgradation</label>
          <label><input type="checkbox" id="iff-upi" checked /> Pay via BHIM/UPI</label>
          <label><input type="checkbox" id="iff-continue" checked /> Click Continue</label>
        </div>
        <button id="iff-run" class="iff-run">Fill Form</button>
        <div id="iff-status" class="iff-status"></div>
      </div>
    `;
    document.body.appendChild(panel);
    statusEl = panel.querySelector("#iff-status");

    panel.querySelector(".iff-min").addEventListener("click", () => {
      panel.classList.toggle("iff-collapsed");
    });

    function renderList(saved, opts) {
      const wrap = panel.querySelector("#iff-list");
      wrap.innerHTML = "";
      if (!saved.length) {
        wrap.innerHTML =
          '<div class="iff-empty">No saved passengers. Click the extension icon in the toolbar to add them.</div>';
        return;
      }
      saved.forEach((p, i) => {
        const id = "iff-p-" + i;
        const row = document.createElement("label");
        row.className = "iff-prow";
        row.innerHTML = `<input type="checkbox" id="${id}" data-i="${i}" checked />
          <span class="iff-pn"></span>
          <span class="iff-pm"></span>`;
        row.querySelector(".iff-pn").textContent = p.name;
        row.querySelector(".iff-pm").textContent =
          [p.age && p.age + "y", p.gender, p.berth].filter(Boolean).join(" · ");
        wrap.appendChild(row);
      });
      if (opts) {
        if (typeof opts.coBrandSkip === "boolean")
          panel.querySelector("#iff-cobrand").checked = opts.coBrandSkip;
        panel.querySelector("#iff-upgrade").checked = !!opts.autoUpgrade;
        panel.querySelector("#iff-upi").checked = !!opts.bhimUpi;
        panel.querySelector("#iff-continue").checked = !!opts.clickContinue;
      }
    }

    getSaved(renderList);

    // Refresh list when the popup edits the stored passengers.
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[KEY]) getSaved(renderList);
      });
    } catch (_) {}

    panel.querySelector("#iff-run").addEventListener("click", () => {
      getSaved(async (saved) => {
        const chosen = Array.from(
          panel.querySelectorAll('#iff-list input[type="checkbox"]:checked')
        ).map((cb) => saved[parseInt(cb.dataset.i, 10)]);

        if (!chosen.length) {
          setStatus("Select at least one passenger (or add some via the toolbar icon).");
          return;
        }
        const opts = {
          coBrandSkip: panel.querySelector("#iff-cobrand").checked,
          autoUpgrade: panel.querySelector("#iff-upgrade").checked,
          bhimUpi: panel.querySelector("#iff-upi").checked,
          clickContinue: panel.querySelector("#iff-continue").checked,
        };
        try {
          chrome.storage.local.set({ iffOpts: opts });
        } catch (_) {}

        const btn = panel.querySelector("#iff-run");
        btn.disabled = true;
        try {
          await runFill(chosen, opts);
        } catch (e) {
          setStatus("Error: " + e.message);
          log(e);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  /* ---------------------------- route watch -------------------------- */

  function onPassengerPage() {
    return /\/nget\/booking\/psgninput/i.test(location.href);
  }

  function removePanel() {
    const p = document.getElementById("irctc-filler-panel");
    if (p) p.remove();
    statusEl = null;
  }

  function syncPanelToRoute() {
    if (onPassengerPage()) buildPanel();
    else removePanel();
  }

  function watchRouteChanges() {
    const fire = () => setTimeout(syncPanelToRoute, 150);
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      fire();
      return r;
    };
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      fire();
      return r;
    };
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        syncPanelToRoute();
      }
    }, 800);
  }

  (async function init() {
    await waitFor(() => document.body, { timeout: 8000 });
    watchRouteChanges();
    syncPanelToRoute();
    log("Loaded. Route:", location.href);
  })();
})();
