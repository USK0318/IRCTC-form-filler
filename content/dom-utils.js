/**
 * content/dom-utils.js — framework-agnostic DOM helpers.
 *
 * IRCTC's "nget" app is Angular + PrimeNG. Angular's value accessors listen
 * for real DOM events ("input"/"blur" on text inputs, "change" on selects and
 * checkboxes), so every setter here writes through the native property setter
 * and then dispatches the events a real user interaction would produce.
 *
 * PrimeNG widgets (p-dropdown, p-checkbox, p-radiobutton, p-autocomplete) are
 * driven by clicking their visible boxes/items, exactly as a user would.
 */
(function () {
  "use strict";
  const NS = (globalThis.IRCTCSF = globalThis.IRCTCSF || {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Lower-case, collapse whitespace, strip punctuation noise like "*" and ":". */
  function norm(s) {
    return String(s ?? "")
      .replace(/[ \s]+/g, " ")
      .replace(/[*:]/g, "")
      .trim()
      .toLowerCase();
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** Whole-word / whole-phrase containment ("male" does not match "female"). */
  function hasWord(haystack, needle) {
    if (!needle) return false;
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(norm(needle))}($|[^a-z0-9])`).test(
      norm(haystack)
    );
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Native inputs inside PrimeNG wrappers are often visually hidden. */
  function isVisibleOrWrapped(el) {
    if (isVisible(el)) return true;
    const wrap = el.closest(
      "p-checkbox, p-radiobutton, p-dropdown, .ui-chkbox, .p-checkbox, .ui-radiobutton, .p-radiobutton"
    );
    return !!wrap && isVisible(wrap);
  }

  function isEditable(el) {
    return !!el && !el.disabled && !el.readOnly && el.getAttribute("aria-disabled") !== "true";
  }

  function textOf(el) {
    return el ? norm(el.innerText || el.textContent || "") : "";
  }

  /**
   * Resolve when predicate() returns a truthy value. Re-evaluates on DOM
   * mutations (fast path) and on a timer (fallback for style-only changes).
   */
  function waitFor(predicate, { timeout = 8000, interval = 250, root = document } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const check = () => {
        if (done) return;
        let v = null;
        try {
          v = predicate();
        } catch (_) {
          v = null;
        }
        if (v) finish(v);
      };
      const finish = (v) => {
        done = true;
        observer.disconnect();
        clearInterval(timer);
        clearTimeout(killer);
        resolve(v);
      };
      const observer = new MutationObserver(check);
      observer.observe(root.documentElement || root, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      const timer = setInterval(check, interval);
      const killer = setTimeout(() => finish(null), timeout);
      check();
    });
  }

  /* -------------------------- event plumbing -------------------------- */

  function fire(el, type, init = {}) {
    const Ctor =
      type.startsWith("key") ? KeyboardEvent : type === "focus" || type === "blur" ? FocusEvent : Event;
    el.dispatchEvent(new Ctor(type, { bubbles: type !== "focus" && type !== "blur", cancelable: true, ...init }));
  }

  /** Write a value through the prototype setter so frameworks notice it. */
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  /** Simulate a user typing a full value into a text input. */
  function setInputValue(el, value) {
    el.focus({ preventScroll: true });
    fire(el, "focus");
    setNativeValue(el, String(value));
    fire(el, "input");
    fire(el, "keyup", { key: String(value).slice(-1) || "Backspace" });
    fire(el, "change");
    fire(el, "blur");
    el.blur();
    return norm(el.value) === norm(value);
  }

  /* ----------------------------- labels -------------------------------- */

  /** Visible text that a user would read as this control's label. */
  function labelTextFor(el) {
    const parts = [];
    const aria = el.getAttribute("aria-label");
    if (aria) parts.push(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      lb.split(/\s+/).forEach((id) => {
        const n = document.getElementById(id);
        if (n) parts.push(n.textContent);
      });
    }
    if (el.id) {
      try {
        document
          .querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)
          .forEach((l) => parts.push(l.textContent));
      } catch (_) {}
    }
    const wrapLabel = el.closest("label");
    if (wrapLabel) parts.push(wrapLabel.textContent);

    // PrimeNG: <p-checkbox label="..."> / <p-radiobutton label="...">
    const prime = el.closest("p-checkbox, p-radiobutton");
    if (prime) {
      if (prime.getAttribute("label")) parts.push(prime.getAttribute("label"));
      const pl = prime.querySelector("label");
      if (pl) parts.push(pl.textContent);
    }

    // Adjacent text (e.g. <input type=checkbox><span>Consider…</span>)
    const host = prime || el;
    const next = host.nextElementSibling;
    if (next && !next.matches("input, select, textarea, p-checkbox, p-radiobutton")) {
      const t = next.textContent;
      if (t && t.length < 200) parts.push(t);
    }
    return norm(parts.join(" "));
  }

  /** Everything we know about a control, as one lowercase string. */
  function describe(el) {
    if (!el) return "";
    const host = el.closest("p-autocomplete, p-dropdown, p-checkbox, p-radiobutton, p-calendar");
    const attrs = ["id", "name", "formcontrolname", "placeholder", "title", "aria-label", "data-label"];
    const bag = [];
    for (const node of [el, host]) {
      if (!node) continue;
      for (const a of attrs) {
        const v = node.getAttribute(a);
        if (v) bag.push(v);
      }
    }
    bag.push(labelTextFor(el));
    // camelCase → words so "passengerAge" matches /\bage\b/
    return norm(bag.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2"));
  }

  /* -------------------------- option matching -------------------------- */

  /**
   * Choose the best option for a wanted value.
   * @param {Array<{text:string,value:string}>} options
   * @param {{wanted:string, synonyms?:string[], codes?:string[], test?:(o)=>boolean}} spec
   * @returns {number} index or -1
   */
  function bestOption(options, spec) {
    const wanted = norm(spec.wanted);
    const syn = (spec.synonyms || []).map(norm);
    const codes = (spec.codes || []).map((c) => String(c).toLowerCase());
    let best = -1;
    let bestScore = 0;
    options.forEach((o, i) => {
      const t = norm(o.text);
      const v = String(o.value ?? "").toLowerCase().replace(/^\d+:\s*/, "").replace(/'/g, "");
      let score = 0;
      if (spec.test && spec.test(o)) score = 95;
      else if (t && t === wanted) score = 100;
      else if (t && syn.includes(t)) score = 90;
      else if (v && codes.includes(v)) score = 85;
      else if (wanted && hasWord(t, wanted)) score = 60 - Math.min(40, t.length - wanted.length);
      else if (syn.some((s) => s && hasWord(t, s))) score = 40 - Math.min(30, t.length);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return best;
  }

  function nativeOptions(select) {
    return Array.from(select.options).map((o) => ({ text: o.textContent, value: o.value, disabled: o.disabled }));
  }

  /** Select an option in a native <select>; returns the chosen text or null. */
  function setNativeSelect(select, spec) {
    const opts = nativeOptions(select);
    const idx = bestOption(opts, spec);
    if (idx < 0 || opts[idx].disabled) return null;
    if (select.selectedIndex !== idx) {
      select.focus({ preventScroll: true });
      select.selectedIndex = idx;
      fire(select, "input");
      fire(select, "change");
      fire(select, "blur");
      select.blur();
    }
    return norm(opts[idx].text) || "(blank)";
  }

  /* ------------------------ PrimeNG dropdown --------------------------- */

  const PRIME_ITEM_SEL =
    ".ui-dropdown-item, .p-dropdown-item, li[role='option'], .ui-dropdown-items li, .p-dropdown-items li";

  function primeDropdownRoot(el) {
    return el.closest("p-dropdown") || el.closest(".ui-dropdown, .p-dropdown") || el;
  }

  function primeDropdownLabel(dd) {
    const l = dd.querySelector(".ui-dropdown-label, .p-dropdown-label");
    return textOf(l);
  }

  async function setPrimeDropdown(dd, spec) {
    const root = primeDropdownRoot(dd);
    const trigger =
      root.querySelector(".ui-dropdown-trigger, .p-dropdown-trigger") ||
      root.querySelector(".ui-dropdown, .p-dropdown") ||
      root;
    trigger.click();
    const items = await waitFor(
      () => {
        const list = Array.from(document.querySelectorAll(PRIME_ITEM_SEL)).filter(isVisible);
        return list.length ? list : null;
      },
      { timeout: 2500, interval: 100 }
    );
    if (!items) return null;
    const opts = items.map((li) => ({ text: li.textContent, value: li.getAttribute("aria-label") || "" }));
    const idx = bestOption(opts, spec);
    if (idx < 0) {
      // close the panel without changing anything
      fire(document.activeElement || document.body, "keydown", { key: "Escape" });
      trigger.click();
      await sleep(150);
      return null;
    }
    items[idx].click();
    await sleep(200);
    return norm(opts[idx].text);
  }

  /** A "select-like" control: native <select> or PrimeNG dropdown. */
  async function setSelectLike(ctrl, spec) {
    if (!ctrl) return null;
    if (ctrl instanceof HTMLSelectElement) return setNativeSelect(ctrl, spec);
    return setPrimeDropdown(ctrl, spec);
  }

  function selectLikeOptionsText(ctrl) {
    if (ctrl instanceof HTMLSelectElement) return nativeOptions(ctrl).map((o) => norm(o.text));
    // Closed PrimeNG dropdowns often keep a hidden native <select> or
    // <option> list for accessibility; fall back to the label.
    const hidden = ctrl.querySelectorAll("option");
    if (hidden.length) return Array.from(hidden).map((o) => norm(o.textContent));
    return [primeDropdownLabel(ctrl)];
  }

  /* ---------------------- checkbox / radio toggles --------------------- */

  function primeBox(ctrl) {
    if (ctrl.matches?.(".ui-chkbox-box, .p-checkbox-box, .ui-radiobutton-box, .p-radiobutton-box")) return ctrl;
    const host = ctrl.closest?.("p-checkbox, p-radiobutton, .ui-chkbox, .p-checkbox, .ui-radiobutton, .p-radiobutton") || ctrl;
    return host.querySelector?.(".ui-chkbox-box, .p-checkbox-box, .ui-radiobutton-box, .p-radiobutton-box") || null;
  }

  function isChecked(ctrl) {
    if (ctrl instanceof HTMLInputElement) return ctrl.checked;
    const aria = ctrl.getAttribute("aria-checked");
    if (aria != null) return aria === "true";
    const box = primeBox(ctrl);
    if (box) return box.classList.contains("ui-state-active") || box.classList.contains("p-highlight");
    const inner = ctrl.querySelector?.("input[type=checkbox], input[type=radio]");
    return inner ? inner.checked : false;
  }

  /** Click the thing a user would click to toggle this control. */
  function clickToggle(ctrl) {
    if (ctrl instanceof HTMLInputElement) {
      const box = primeBox(ctrl);
      if (box && isVisible(box)) box.click();
      else ctrl.click();
      return;
    }
    const box = primeBox(ctrl);
    (box && isVisible(box) ? box : ctrl).click();
  }

  async function setChecked(ctrl, desired) {
    if (isChecked(ctrl) === desired) return true;
    clickToggle(ctrl);
    await sleep(120);
    return isChecked(ctrl) === desired;
  }

  async function selectRadio(ctrl) {
    if (isChecked(ctrl)) return true;
    clickToggle(ctrl);
    await sleep(150);
    return isChecked(ctrl);
  }

  /** Smallest ancestor of `el` (inclusive, up to maxUp levels) that satisfies test. */
  function closestMatching(el, test, maxUp = 10) {
    let n = el;
    for (let i = 0; n && i <= maxUp; i++, n = n.parentElement) {
      if (test(n)) return n;
      if (n === document.body) break;
    }
    return null;
  }

  function byDocumentOrder(a, b) {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  Object.assign(NS, {
    sleep,
    norm,
    hasWord,
    isVisible,
    isVisibleOrWrapped,
    isEditable,
    textOf,
    waitFor,
    fire,
    setNativeValue,
    setInputValue,
    labelTextFor,
    describe,
    bestOption,
    setNativeSelect,
    setPrimeDropdown,
    setSelectLike,
    selectLikeOptionsText,
    isChecked,
    setChecked,
    selectRadio,
    closestMatching,
    byDocumentOrder,
  });
})();
