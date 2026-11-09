/**
 * content/filler.js — fills / clears the IRCTC passenger form and builds a
 * per-field report. It NEVER clicks Continue, never touches CAPTCHA/OTP and
 * never interacts with a payment gateway: it only selects the payment-mode
 * radio the user configured, which IRCTC uses on the next page.
 *
 * Reports contain field names and statuses only — never passenger values.
 */
(function () {
  "use strict";
  const NS = (globalThis.IRCTCSF = globalThis.IRCTCSF || {});
  const {
    sleep, norm, hasWord, isEditable, waitFor, setInputValue, setSelectLike, setChecked, selectRadio,
    findPassengerRows, findAddPassengerTrigger, findAddInfantTrigger, findContactFields, findCheckbox,
    findInsuranceRadios, findPaymentRadios, findReservationChoice, findCoachInput, isBookingPage,
  } = NS;

  const LIMITS = { NAME_MIN: 3, NAME_MAX: 16, AGE_MIN: 1, AGE_MAX: 125, INFANT_AGE_MAX: 4, MAX_PASSENGERS: 6 };

  class AbortFill extends Error {}

  /* ---------------------------- report ------------------------------- */

  function createReport(action) {
    const items = [];
    const add = (status, scope, field, message = "") => items.push({ status, scope, field, message });
    return {
      ok: (s, f, m) => add("ok", s, f, m),
      info: (s, f, m) => add("info", s, f, m),
      warn: (s, f, m) => add("warn", s, f, m),
      error: (s, f, m) => add("error", s, f, m),
      finish(extra = {}) {
        const summary = { ok: 0, info: 0, warn: 0, error: 0 };
        items.forEach((i) => summary[i.status]++);
        return { action, items, summary, ...extra };
      },
    };
  }

  /* --------------------------- value specs --------------------------- */

  const GENDER_SPEC = {
    Male: { wanted: "Male", codes: ["m"] },
    Female: { wanted: "Female", codes: ["f"] },
    Transgender: { wanted: "Transgender", synonyms: ["third gender", "other"], codes: ["t", "tg"] },
  };

  const BERTH_SPEC = {
    "No Preference": {
      wanted: "No Preference",
      synonyms: ["no choice", "none", "any"],
      test: (o) => String(o.value ?? "").replace(/^\d+:\s*/, "").trim() === "" && /prefer|choice|select|berth/.test(norm(o.text)),
    },
    Lower: { wanted: "Lower", synonyms: ["lower berth"], codes: ["lb"] },
    Middle: { wanted: "Middle", synonyms: ["middle berth"], codes: ["mb"] },
    Upper: { wanted: "Upper", synonyms: ["upper berth"], codes: ["ub"] },
    "Side Lower": { wanted: "Side Lower", synonyms: ["side lower berth"], codes: ["sl"] },
    "Side Upper": { wanted: "Side Upper", synonyms: ["side upper berth"], codes: ["su"] },
  };

  const FOOD_SPEC = {
    Veg: { wanted: "Veg", synonyms: ["vegetarian"], codes: ["v"] },
    "Non Veg": { wanted: "Non Veg", synonyms: ["non-veg", "nonveg", "non vegetarian"], codes: ["n"] },
    "Jain Meal": { wanted: "Jain Meal", synonyms: ["jain"], codes: ["j"] },
    "No Food": { wanted: "No Food", synonyms: ["no meal"], codes: ["d"] },
  };

  const RESERVATION_SPEC = {
    none: { wanted: "None", test: (o) => /^none$|^no reservation choice|^no choice/.test(norm(o.text)) },
    one_lower: { wanted: "", test: (o) => /(\b1\b|\bone\b|atleast 1|at least 1).*lower/.test(norm(o.text)) },
    two_lower: { wanted: "", test: (o) => /(\b2\b|\btwo\b).*lower/.test(norm(o.text)) },
    same_coach: { wanted: "", test: (o) => /same coach/.test(norm(o.text)) },
  };

  function nationalitySpec(country) {
    const c = country || "India";
    return /^india$/i.test(c) ? { wanted: "India", synonyms: ["indian"], codes: ["in", "ind"] } : { wanted: c };
  }

  const AGE_WORDS = ["zero", "one", "two", "three", "four"];
  function infantAgeSpec(age) {
    return {
      wanted: "",
      test: (o) => {
        const t = norm(o.text);
        const v = String(o.value ?? "").replace(/^\d+:\s*/, "").trim();
        if (age === 0) return /below|less than|under|< ?1|^0\b/.test(t) || v === "0";
        if (/below|less than|under/.test(t)) return false;
        return new RegExp(`(^|\\D)${age}(\\D|$)`).test(t) || hasWord(t, AGE_WORDS[age]) || v === String(age);
      },
    };
  }

  /* --------------------------- validation ---------------------------- */

  function checkPassenger(p, infant) {
    const errs = [];
    const name = String(p.name || "").replace(/\s+/g, " ").trim();
    if (!/^[A-Za-z ]+$/.test(name) || name.length < LIMITS.NAME_MIN || name.length > LIMITS.NAME_MAX)
      errs.push(`name must be ${LIMITS.NAME_MIN}–${LIMITS.NAME_MAX} letters`);
    const age = Number(p.age);
    const max = infant ? LIMITS.INFANT_AGE_MAX : LIMITS.AGE_MAX;
    const min = infant ? 0 : p.type === "infant_with_berth" ? 0 : LIMITS.AGE_MIN;
    if (!Number.isInteger(age) || age < min || age > max) errs.push(`age must be ${min}–${max}`);
    return { ok: errs.length === 0, errs, name, age };
  }

  /* ------------------------------ steps ------------------------------ */

  function makeGuard(state) {
    return () => {
      if (state.cancelled) throw new AbortFill("Cancelled.");
      if (!isBookingPage()) throw new AbortFill("You navigated away from the Passenger Details page. Filling stopped.");
    };
  }

  async function ensureRows(kind, needed, report, guard, progress) {
    const count = () => findPassengerRows()[kind === "infant" ? "infants" : "adults"].length;
    const label = kind === "infant" ? "Infant (without berth) rows" : "Passenger rows";
    let have = count();
    let attempts = 0;
    while (have < needed && attempts < needed + 2) {
      guard();
      const trigger = kind === "infant" ? findAddInfantTrigger() : findAddPassengerTrigger();
      if (!trigger) {
        report.error("Form", label, `Needed ${needed}, found ${have}. "Add ${kind === "infant" ? "Infant Without Berth" : "Passenger"}" link not found.`);
        return have;
      }
      progress(`Adding ${kind === "infant" ? "infant" : "passenger"} row ${have + 1}…`);
      trigger.click();
      attempts++;
      const grew = await waitFor(() => count() > have, { timeout: 4000 });
      if (!grew) {
        report.error("Form", label, `IRCTC did not add row ${have + 1}. The quota/class may limit how many can be booked.`);
        return count();
      }
      have = count();
      await sleep(150);
    }
    return have;
  }

  async function dismissAutocomplete(input) {
    await sleep(250);
    NS.fire(input, "keydown", { key: "Escape", code: "Escape", keyCode: 27 });
    NS.fire(input, "keyup", { key: "Escape", code: "Escape", keyCode: 27 });
    await sleep(100);
  }

  async function fillSelectField(report, scope, field, ctrl, spec, { optionalMissing } = {}) {
    if (!ctrl) {
      if (optionalMissing) report.info(scope, field, optionalMissing);
      else report.warn(scope, field, "Field not found on the page — set it manually.");
      return false;
    }
    const chosen = await setSelectLike(ctrl, spec);
    if (chosen == null) {
      report.warn(scope, field, "Matching option not available — set it manually.");
      return false;
    }
    report.ok(scope, field);
    return true;
  }

  async function fillAdultRow(index, p, report, guard) {
    const scope = `Passenger ${index + 1}`;
    const v = checkPassenger(p, false);
    if (!v.ok) {
      report.error(scope, "Profile", `Skipped: ${v.errs.join(", ")}.`);
      return;
    }
    let row = findPassengerRows().adults[index];
    if (!row) return report.error(scope, "Row", "Passenger row disappeared before it could be filled.");

    // Name (PrimeNG autocomplete — type it, then dismiss suggestions)
    if (!row.name) report.error(scope, "Name", "Name field not found.");
    else if (!isEditable(row.name)) report.warn(scope, "Name", "Field is locked by IRCTC.");
    else {
      const ok = setInputValue(row.name, v.name);
      await dismissAutocomplete(row.name);
      ok ? report.ok(scope, "Name") : report.warn(scope, "Name", "Value did not stick — retype it.");
    }
    guard();

    // Age (a text input on adult rows)
    if (!row.age) report.error(scope, "Age", "Age field not found.");
    else if (row.age instanceof HTMLSelectElement || row.age.tagName === "P-DROPDOWN") {
      await fillSelectField(report, scope, "Age", row.age, { wanted: String(v.age) });
    } else if (!isEditable(row.age)) report.warn(scope, "Age", "Field is locked by IRCTC.");
    else setInputValue(row.age, String(v.age)) ? report.ok(scope, "Age") : report.warn(scope, "Age", "Value did not stick.");
    await sleep(200);
    guard();

    // Age can make IRCTC add/remove fields (child berth, senior concession) — rescan.
    row = findPassengerRows().adults[index] || row;

    await fillSelectField(report, scope, "Gender", row.gender, GENDER_SPEC[p.gender] || { wanted: p.gender });
    await fillSelectField(report, scope, "Nationality", row.nationality, nationalitySpec(p.nationality), {
      optionalMissing: "Not shown for this booking — IRCTC default kept.",
    });
    await fillSelectField(report, scope, "Berth preference", row.berth, BERTH_SPEC[p.berth] || BERTH_SPEC["No Preference"], {
      optionalMissing: "Not offered for this train/class.",
    });
    if (p.food && p.food !== "No Preference") {
      await fillSelectField(report, scope, "Food choice", row.food, FOOD_SPEC[p.food] || { wanted: p.food }, {
        optionalMissing: "Catering choice not offered for this train.",
      });
    }
    if (p.type === "infant_with_berth") {
      report.info(scope, "Infant with berth", "Filled as a full passenger row. Check any child/infant notice IRCTC shows.");
    }
    if (v.age >= 5 && v.age <= 11) report.info(scope, "Child berth", "IRCTC may show a child-berth option — choose it manually.");
    if (v.age >= 58) report.info(scope, "Concession", "Check the senior-citizen concession option IRCTC shows.");
    guard();
  }

  async function fillInfantRow(index, p, report, guard) {
    const scope = `Infant ${index + 1}`;
    const v = checkPassenger(p, true);
    if (!v.ok) {
      report.error(scope, "Profile", `Skipped: ${v.errs.join(", ")}.`);
      return;
    }
    const row = findPassengerRows().infants[index];
    if (!row) return report.error(scope, "Row", "Infant row not found.");

    if (!row.name) report.error(scope, "Name", "Name field not found.");
    else {
      const ok = setInputValue(row.name, v.name);
      await dismissAutocomplete(row.name);
      ok ? report.ok(scope, "Name") : report.warn(scope, "Name", "Value did not stick — retype it.");
    }
    guard();
    if (row.age && !(row.age instanceof HTMLInputElement)) {
      await fillSelectField(report, scope, "Age", row.age, infantAgeSpec(v.age));
    } else if (row.age) {
      setInputValue(row.age, String(v.age)) ? report.ok(scope, "Age") : report.warn(scope, "Age", "Value did not stick.");
    } else report.error(scope, "Age", "Age field not found.");
    await fillSelectField(report, scope, "Gender", row.gender, GENDER_SPEC[p.gender] || { wanted: p.gender });
    guard();
  }

  async function fillContact(contact, rows, report) {
    if (!contact || (!contact.mobile && !contact.email)) return;
    const fields = findContactFields([...rows.adults, ...rows.infants]);
    for (const [key, label] of [["mobile", "Mobile number"], ["email", "Email"]]) {
      const value = contact[key];
      if (!value) continue;
      const el = fields[key];
      if (!el) report.info("Contact", label, "Field not shown on this page.");
      else if (!isEditable(el)) report.info("Contact", label, "Locked by IRCTC — kept as is.");
      else if (el.value.trim() && !contact.overwriteExisting)
        report.info("Contact", label, "Already filled by IRCTC — kept (enable overwrite in Settings to replace).");
      else if (norm(el.value) === norm(value)) report.ok("Contact", label, "Already correct.");
      else setInputValue(el, value) ? report.ok("Contact", label) : report.warn("Contact", label, "Value did not stick.");
    }
  }

  async function fillPreferences(prefs, rows, report, guard) {
    if (!prefs) return;
    const scope = "Preferences";
    const toggles = [
      ["autoUpgrade", "Consider for Auto Upgradation", /auto ?upgrad/],
      ["confirmBerths", "Book only if confirm berths are allotted", /confirm berth/],
    ];
    for (const [key, label, re] of toggles) {
      if (typeof prefs[key] !== "boolean") continue;
      const ctrl = findCheckbox(re);
      if (!ctrl) report.info(scope, label, "Option not shown for this booking.");
      else if ((await setChecked(ctrl, prefs[key]))) report.ok(scope, label, prefs[key] ? "Checked." : "Unchecked.");
      else report.warn(scope, label, "Could not toggle — set it manually.");
      guard();
    }

    if (prefs.reservationChoice && prefs.reservationChoice !== "skip") {
      const ctrl = findReservationChoice([...rows.adults, ...rows.infants]);
      await fillSelectField(report, scope, "Reservation choice", ctrl, RESERVATION_SPEC[prefs.reservationChoice], {
        optionalMissing: "Reservation choice not offered for this booking.",
      });
      guard();
    }

    if (prefs.coachNumber) {
      const el = findCoachInput([...rows.adults, ...rows.infants]);
      if (!el) report.info(scope, "Preferred coach", "Field not shown for this booking.");
      else setInputValue(el, prefs.coachNumber) ? report.ok(scope, "Preferred coach") : report.warn(scope, "Preferred coach", "Value did not stick.");
    }
  }

  async function chooseRadio(report, scope, field, list, picker) {
    if (!list.length) return report.info(scope, field, "Options not shown on this page.");
    const target = list.find(picker);
    if (!target) return report.warn(scope, field, "Matching option not found — choose it manually.");
    (await selectRadio(target.ctrl)) ? report.ok(scope, field) : report.warn(scope, field, "Could not select — choose it manually.");
  }

  async function fillInsurance(choice, report) {
    if (!choice || choice === "skip") return;
    const want = choice === "yes";
    await chooseRadio(report, "Travel insurance", want ? "Yes" : "No", findInsuranceRadios(), (r) =>
      want
        ? /^yes\b/.test(r.text) || (r.value === "true" && !/^no\b/.test(r.text))
        : /^no\b|don.?t want/.test(r.text) || (r.value === "false" && !/^yes\b/.test(r.text))
    );
  }

  async function fillPaymentMode(mode, report) {
    if (!mode || mode === "skip") return;
    const upi = mode === "upi";
    await chooseRadio(report, "Payment mode", upi ? "BHIM / UPI" : "Cards / Net Banking / Wallets", findPaymentRadios(), (r) =>
      upi ? /bhim/.test(r.text) || (/\bupi\b/.test(r.text) && !/credit|debit|net ?banking|wallet/.test(r.text)) : /credit|debit|net ?banking|wallet/.test(r.text)
    );
  }

  /* --------------------------- entry points -------------------------- */

  const state = { busy: false, cancelled: false };

  async function waitForRows(report) {
    const rows = await waitFor(() => {
      const r = findPassengerRows();
      return r.adults.length ? r : null;
    }, { timeout: 15000 });
    if (!rows) {
      report.error("Form", "Passenger rows", "No passenger fields detected. Wait for the page to finish loading, then try again.");
    }
    return rows;
  }

  async function fill(payload, progress = () => {}) {
    if (state.busy) return { action: "fill", busy: true, items: [], summary: {}, error: "A fill is already running." };
    state.busy = true;
    state.cancelled = false;
    const report = createReport("fill");
    const guard = makeGuard(state);
    try {
      guard();
      const list = Array.isArray(payload?.passengers) ? payload.passengers : [];
      const adultsData = list.filter((p) => p.type !== "infant_without_berth");
      const infantsData = list.filter((p) => p.type === "infant_without_berth");
      if (!list.length) {
        report.error("Selection", "Passengers", "No passengers selected.");
        return report.finish();
      }
      if (adultsData.length === 0) {
        report.error("Selection", "Passengers", "An infant without berth must travel with at least one passenger.");
        return report.finish();
      }
      if (adultsData.length > LIMITS.MAX_PASSENGERS) {
        report.error("Selection", "Passengers", `IRCTC allows at most ${LIMITS.MAX_PASSENGERS} passengers per ticket (4 for Tatkal).`);
        return report.finish();
      }

      progress("Waiting for passenger fields…");
      if (!(await waitForRows(report))) return report.finish();

      const adultRows = await ensureRows("adult", adultsData.length, report, guard, progress);
      for (let i = 0; i < Math.min(adultRows, adultsData.length); i++) {
        progress(`Filling passenger ${i + 1} of ${adultsData.length}…`);
        await fillAdultRow(i, adultsData[i], report, guard);
      }
      const extra = findPassengerRows().adults.length - adultsData.length;
      if (extra > 0) report.warn("Form", "Extra rows", `${extra} passenger row(s) left untouched — remove them or IRCTC will ask you to fill them.`);

      if (infantsData.length) {
        const infantRows = await ensureRows("infant", infantsData.length, report, guard, progress);
        for (let i = 0; i < Math.min(infantRows, infantsData.length); i++) {
          progress(`Filling infant ${i + 1} of ${infantsData.length}…`);
          await fillInfantRow(i, infantsData[i], report, guard);
        }
      }

      const rows = findPassengerRows();
      progress("Applying contact details and preferences…");
      await fillContact(payload.contact, rows, report);
      await fillPreferences(payload.preferences, rows, report, guard);
      await fillInsurance(payload.insurance, report);
      await fillPaymentMode(payload.paymentMode, report);
      guard();
      return report.finish();
    } catch (e) {
      if (e instanceof AbortFill) {
        report.error("Fill", "Stopped", e.message);
        return report.finish({ aborted: true });
      }
      report.error("Fill", "Unexpected error", "The page structure may have changed. Fill the remaining fields manually.");
      return report.finish({ aborted: true });
    } finally {
      state.busy = false;
    }
  }

  async function clear(progress = () => {}) {
    if (state.busy) return { action: "clear", busy: true, items: [], summary: {}, error: "A fill is running." };
    state.busy = true;
    state.cancelled = false;
    const report = createReport("clear");
    const guard = makeGuard(state);
    try {
      guard();
      progress("Clearing passenger fields…");
      const rows = findPassengerRows();
      if (!rows.adults.length && !rows.infants.length) {
        report.error("Form", "Passenger rows", "No passenger fields detected.");
        return report.finish();
      }
      const blank = { wanted: "", test: (o) => String(o.value ?? "").replace(/^\d+:\s*/, "").trim() === "" };
      const all = [
        ...rows.adults.map((r, i) => [`Passenger ${i + 1}`, r]),
        ...rows.infants.map((r, i) => [`Infant ${i + 1}`, r]),
      ];
      for (const [scope, r] of all) {
        guard();
        if (r.name && isEditable(r.name)) setInputValue(r.name, "");
        if (r.age instanceof HTMLInputElement && isEditable(r.age)) setInputValue(r.age, "");
        else if (r.age instanceof HTMLSelectElement) NS.setNativeSelect(r.age, blank);
        if (r.gender instanceof HTMLSelectElement) NS.setNativeSelect(r.gender, blank);
        if (r.berth instanceof HTMLSelectElement) NS.setNativeSelect(r.berth, BERTH_SPEC["No Preference"]);
        if (r.food instanceof HTMLSelectElement) NS.setNativeSelect(r.food, blank);
        report.ok(scope, "Cleared");
        await sleep(50);
      }
      const coach = findCoachInput([...rows.adults, ...rows.infants]);
      if (coach && coach.value) setInputValue(coach, "");
      report.info("Form", "Not cleared", "Contact details, preferences, insurance and payment mode were left as they are.");
      return report.finish();
    } catch (e) {
      report.error("Clear", "Stopped", e instanceof AbortFill ? e.message : "Unexpected error while clearing.");
      return report.finish({ aborted: true });
    } finally {
      state.busy = false;
    }
  }

  function cancel() {
    state.cancelled = true;
  }

  Object.assign(NS, { fill, clear, cancel, fillState: state });
})();
