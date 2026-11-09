/**
 * storage.js — persistence + validation for IRCTC Smart Filler.
 *
 * Everything lives in chrome.storage.local on this device. Nothing is ever
 * sent over the network. This module is shared by the popup and the
 * background service worker (both load it as an ES module).
 *
 * Never stored: IRCTC passwords, OTPs, card numbers, UPI PINs or any other
 * banking credential. There are no fields for them anywhere in the schema.
 */

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Domain constants                                                    */
/* ------------------------------------------------------------------ */

export const PASSENGER_TYPES = [
  { value: "passenger", label: "Passenger (adult / child 5+ years)" },
  { value: "infant_with_berth", label: "Infant under 5 — with berth" },
  { value: "infant_without_berth", label: "Infant under 5 — without berth" },
];

export const GENDERS = ["Male", "Female", "Transgender"];

export const BERTHS = [
  "No Preference",
  "Lower",
  "Middle",
  "Upper",
  "Side Lower",
  "Side Upper",
];

export const FOOD_CHOICES = [
  "No Preference",
  "Veg",
  "Non Veg",
  "Jain Meal",
  "No Food",
];

export const NATIONALITIES = [
  "India",
  "Bangladesh",
  "Bhutan",
  "Nepal",
  "Sri Lanka",
  "United States",
  "United Kingdom",
  "Canada",
  "Australia",
  "Germany",
  "France",
  "Japan",
  "Singapore",
  "United Arab Emirates",
];

export const RESERVATION_CHOICES = [
  { value: "skip", label: "Don't change" },
  { value: "none", label: "None" },
  { value: "one_lower", label: "Book only if at least 1 lower berth is allotted" },
  { value: "two_lower", label: "Book only if 2 lower berths are allotted" },
  { value: "same_coach", label: "Book only if all berths are allotted in same coach" },
];

export const INSURANCE_CHOICES = [
  { value: "yes", label: "Yes, I want travel insurance" },
  { value: "no", label: "No, I don't want travel insurance" },
  { value: "skip", label: "Don't change" },
];

export const PAYMENT_CHOICES = [
  { value: "cards", label: "Credit Card / Debit Card / Net Banking / Wallets / EMI / UPI" },
  { value: "upi", label: "BHIM / UPI" },
  { value: "skip", label: "Don't change" },
];

/** IRCTC's own limits (checked again on the page by IRCTC itself). */
export const LIMITS = {
  NAME_MIN: 3,
  NAME_MAX: 16,
  AGE_MIN: 1,
  AGE_MAX: 125,
  INFANT_AGE_MAX: 4,
  MAX_PASSENGERS: 6,
  MAX_INFANTS: 2,
};

const KEYS = {
  passengers: "passengers",
  groups: "groups",
  settings: "settings",
  selection: "selection",
  schema: "schemaVersion",
};

export const DEFAULT_SETTINGS = Object.freeze({
  contact: { mobile: "", email: "", overwriteExisting: false },
  preferences: {
    autoUpgrade: true,
    confirmBerths: false,
    reservationChoice: "skip",
    coachNumber: "",
  },
  insurance: "skip",
  paymentMode: "skip",
  ui: { autoShowPanel: true },
  autoFlow: {
    continueAfterFill: true, // click Continue on Passenger + Review pages
    selectGateway: true, // on the Payment page, pick the method below (never Pay & Book)
    gatewayCategory: "BHIM/ UPI/ USSD",
    gatewayOption: "Paytm UPI",
    clickPayBook: false, // opt-in: click "Pay & Book" after a countdown
    payBookDelaySec: 5,
  },
});

export const GATEWAY_CATEGORIES = ["BHIM/ UPI/ USSD", "IRCTC iPay (Credit Card/Debit Card/UPI)", "Multiple Payment Service"];
export const GATEWAY_OPTIONS = ["Paytm UPI", "Amazon Pay", "IRCTC iPay New"];

export const DEFAULT_SELECTION = Object.freeze({
  mode: "passengers", // "passengers" | "group"
  passengerIds: [],
  groupId: "",
});

/* ------------------------------------------------------------------ */
/* Low-level helpers                                                   */
/* ------------------------------------------------------------------ */

function get(keys) {
  return chrome.storage.local.get(keys);
}

function set(items) {
  return chrome.storage.local.set(items);
}

export function uid(prefix = "id") {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Deep-merge stored settings over the defaults so new fields get defaults. */
function mergeSettings(stored) {
  const d = clone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== "object") return d;
  return {
    contact: { ...d.contact, ...(stored.contact || {}) },
    preferences: { ...d.preferences, ...(stored.preferences || {}) },
    insurance: stored.insurance || d.insurance,
    paymentMode: stored.paymentMode || d.paymentMode,
    ui: { ...d.ui, ...(stored.ui || {}) },
    autoFlow: { ...d.autoFlow, ...(stored.autoFlow || {}) },
  };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function normalizeName(name) {
  return String(name || "").replace(/\s+/g, " ").trim();
}

export function isInfantType(type) {
  return type === "infant_with_berth" || type === "infant_without_berth";
}

/**
 * Validate and normalise a passenger profile.
 * @returns {{valid: boolean, errors: Record<string,string>, value: object}}
 */
export function validatePassenger(input) {
  const errors = {};
  const type = PASSENGER_TYPES.some((t) => t.value === input.type)
    ? input.type
    : "passenger";
  const name = normalizeName(input.name);
  const infant = isInfantType(type);

  if (!name) errors.name = "Name is required.";
  else if (!/^[A-Za-z ]+$/.test(name))
    errors.name = "Use letters and spaces only (as on the Government ID).";
  else if (name.length < LIMITS.NAME_MIN || name.length > LIMITS.NAME_MAX)
    errors.name = `IRCTC accepts ${LIMITS.NAME_MIN}–${LIMITS.NAME_MAX} characters.`;

  const ageStr = String(input.age ?? "").trim();
  const age = Number(ageStr);
  if (ageStr === "" || !Number.isInteger(age)) errors.age = "Enter age in whole years.";
  else if (infant && (age < 0 || age > LIMITS.INFANT_AGE_MAX))
    errors.age = `Infant types are only for ages 0–${LIMITS.INFANT_AGE_MAX}. For age ${age}, set Type to "Passenger".`;
  else if (!infant && (age < LIMITS.AGE_MIN || age > LIMITS.AGE_MAX))
    errors.age = `Age must be ${LIMITS.AGE_MIN}–${LIMITS.AGE_MAX}.`;

  const gender = GENDERS.includes(input.gender) ? input.gender : "";
  if (!gender) errors.gender = "Select a gender.";

  const nationality = normalizeName(input.nationality) || "India";
  if (!/^[A-Za-z .()'-]+$/.test(nationality)) errors.nationality = "Enter a valid country name.";

  const berth = BERTHS.includes(input.berth) ? input.berth : "No Preference";
  const food = FOOD_CHOICES.includes(input.food) ? input.food : "No Preference";

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    value: {
      id: input.id || uid("p"),
      type,
      name,
      age: Number.isInteger(age) ? age : null,
      gender,
      nationality,
      berth: type === "infant_without_berth" ? "No Preference" : berth,
      food: type === "infant_without_berth" ? "No Preference" : food,
    },
  };
}

export function validateContact(contact) {
  const errors = {};
  let mobile = String(contact.mobile || "").replace(/[\s-]/g, "");
  if (mobile.startsWith("+91")) mobile = mobile.slice(3);
  else if (mobile.length === 11 && mobile.startsWith("0")) mobile = mobile.slice(1);
  if (mobile && !/^[6-9]\d{9}$/.test(mobile))
    errors.mobile = "Enter a 10-digit Indian mobile number.";

  const email = String(contact.email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    errors.email = "Enter a valid email address.";

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    value: { mobile, email, overwriteExisting: !!contact.overwriteExisting },
  };
}

export function validateCoachNumber(coach) {
  const c = String(coach || "").trim().toUpperCase();
  if (c && !/^[A-Z0-9]{1,4}$/.test(c))
    return { valid: false, error: "Coach number is 1–4 letters/digits (e.g. B2, S10).", value: c };
  return { valid: true, error: "", value: c };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Seed defaults on install / upgrade without touching existing data. */
export async function ensureDefaults() {
  const data = await get(Object.values(KEYS));
  const patch = {};
  if (!Array.isArray(data.passengers)) patch.passengers = [];
  if (!Array.isArray(data.groups)) patch.groups = [];
  patch.settings = mergeSettings(data.settings);
  if (!data.selection) patch.selection = clone(DEFAULT_SELECTION);
  patch.schemaVersion = SCHEMA_VERSION;
  await set(patch);
}

export async function loadAll() {
  const data = await get(Object.values(KEYS));
  return {
    passengers: Array.isArray(data.passengers) ? data.passengers : [],
    groups: Array.isArray(data.groups) ? data.groups : [],
    settings: mergeSettings(data.settings),
    selection: { ...DEFAULT_SELECTION, ...(data.selection || {}) },
  };
}

export async function savePassenger(input) {
  const result = validatePassenger(input);
  if (!result.valid) return result;
  const { passengers } = await loadAll();
  const idx = passengers.findIndex((p) => p.id === result.value.id);
  if (idx >= 0) passengers[idx] = result.value;
  else passengers.push(result.value);
  await set({ passengers });
  return result;
}

export async function deletePassenger(id) {
  const { passengers, groups, selection } = await loadAll();
  await set({
    passengers: passengers.filter((p) => p.id !== id),
    groups: groups.map((g) => ({
      ...g,
      passengerIds: g.passengerIds.filter((pid) => pid !== id),
    })),
    selection: {
      ...selection,
      passengerIds: selection.passengerIds.filter((pid) => pid !== id),
    },
  });
}

export async function movePassenger(id, delta) {
  const { passengers } = await loadAll();
  const i = passengers.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= passengers.length) return;
  [passengers[i], passengers[j]] = [passengers[j], passengers[i]];
  await set({ passengers });
}

export async function saveGroup(input) {
  const name = normalizeName(input.name);
  const passengerIds = Array.isArray(input.passengerIds) ? input.passengerIds : [];
  const errors = {};
  if (!name) errors.name = "Group name is required.";
  else if (name.length > 40) errors.name = "Keep the group name under 40 characters.";
  if (!passengerIds.length) errors.passengerIds = "Pick at least one passenger.";
  if (Object.keys(errors).length) return { valid: false, errors };

  const value = { id: input.id || uid("g"), name, passengerIds };
  const { groups } = await loadAll();
  const idx = groups.findIndex((g) => g.id === value.id);
  if (idx >= 0) groups[idx] = value;
  else groups.push(value);
  await set({ groups });
  return { valid: true, errors: {}, value };
}

export async function deleteGroup(id) {
  const { groups, selection } = await loadAll();
  await set({
    groups: groups.filter((g) => g.id !== id),
    selection: selection.groupId === id ? { ...selection, groupId: "" } : selection,
  });
}

export async function saveSettings(settings) {
  const merged = mergeSettings(settings);
  await set({ settings: merged });
  return merged;
}

export async function saveSelection(selection) {
  await set({ selection: { ...DEFAULT_SELECTION, ...selection } });
}

/** Permanently removes every saved profile, group and setting. */
export async function clearAllData() {
  await chrome.storage.local.clear();
  await ensureDefaults();
}
