# IRCTC Smart Filler (Chrome Extension, Manifest V3)

Save passenger profiles and booking preferences once. On the IRCTC **Passenger
Details** page (`https://www.irctc.co.in/nget/booking/psgninput`), click
**Fill Form** and the extension fills everything it can. Then **you** review
the page and click **Continue**.

If you turn on **After filling** (it's on by default), the extension also
clicks **Continue** on the Passenger Details and Review Journey pages. On the
Payment page it selects your chosen method, for example **BHIM/ UPI/ USSD →
Paytm UPI**. By default it stops there and you click **Pay & Book**. If you
turn on **Then click Pay & Book automatically**, it clicks Pay & Book once,
after a countdown (5 s by default) that you can Cancel from the panel. You
still approve the payment yourself in your UPI app. It never types a CAPTCHA,
OTP or login, and it never enters payment details.

---

## Features

| Area | What it does |
|---|---|
| Passenger profiles | Add, edit, delete and reorder. Fields: full name (as per Govt. ID), age, gender (Male/Female/Transgender), nationality (default India), berth (No Preference/Lower/Middle/Upper/Side Lower/Side Upper), and optional food choice. |
| Passenger types | **Passenger**, **Infant (with berth)** (filled as a normal passenger row via *Add Passenger / Add Infant With Berth*), **Infant (without berth)** (filled in the *Add Infant Without Berth* rows). |
| Groups | Save combinations like "Family" or "Parents". Pick one group or individual passengers for each booking. The order shown is the order the IRCTC rows are filled in. |
| Contact | Mobile and email. Existing IRCTC values are **kept** unless you turn on *Overwrite contact details*. |
| Other preferences | Consider for Auto Upgradation, Book only if confirm berths are allotted, Reservation Choice, Preferred Coach Number. |
| Travel insurance | Yes / No / Don't change. |
| Payment mode | Cards/Net Banking/Wallets/EMI/UPI, BHIM/UPI, or Don't change. Only the radio option is selected. |
| Auto-open panel | When you reach Passenger Details, a floating **IRCTC Smart Filler** panel opens on the page by itself, with passenger/group selection and **Fill Form** / **Clear Form**. You can minimise it (▁) or close it (✕); closing only lasts until your next visit to the page. Turn it off in **Settings → On the IRCTC page**. |
| After filling (optional) | **Continue** is clicked only if every field filled without a warning or error. If Review Journey shows a CAPTCHA, the panel asks you to type it and click Continue yourself; the payment method is still picked on the next page. IRCTC can be slow, so each step waits up to 3 minutes for the next page and for IRCTC's loading spinner to clear, with a live counter in the panel. Continue is never clicked twice. If IRCTC is still on Passenger Details after that (usually a validation error), the panel says so; fix it and click Continue yourself, and the chain picks up from Review Journey. The payment method and option are set in **Settings → After filling**. The code refuses to click anything labelled *Pay & Book*. |
| Report | Every field gets a status (filled / note / check / failed), shown in the panel and in the popup. |

## How it works

```
popup (popup.js) ──chrome.storage.local──► your profiles (this browser only)
      │
      └─ tabs.sendMessage(FILL / CLEAR / PING) ─► content script on irctc.co.in/nget/*
                                                    ├─ content/detector.js  finds fields by meaning
                                                    ├─ content/filler.js    fills + builds report
                                                    ├─ content/dom-utils.js Angular/PrimeNG-safe setters
                                                    ├─ content/panel.js     auto-opening on-page panel + report
                                                    └─ content/autoflow.js  Continue → Continue → payment method (stops before Pay & Book)
background.js ─ seeds defaults, shows an "ON" badge when the passenger page is open
```

**Field detection doesn't rely on fixed CSS selectors.** Each control is matched using:
1. Semantic attributes: `formcontrolname`, `name`, `id`, `placeholder`, `aria-*`.
2. Visible label text: `<label for>`, wrapping labels, PrimeNG `label=""`, and nearby text.
3. What the control contains. For example, a dropdown whose options are Male/Female is the gender field, and one with Lower/Upper is the berth field.

Passenger rows are found by starting at each gender field and moving up to the
smallest container that also has a name field. Infant rows are told apart by
their age dropdown, or by an `infant` hint in the component or field names.

**Angular/PrimeNG compatibility.** Values are written through the native
property setter, followed by the events a real user would trigger (`focus`,
`input`, `keyup`, `change`, `blur`). PrimeNG dropdowns, checkboxes and radios
are clicked like a user would click them. When rows are missing, the extension
clicks *Add Passenger* or *Add Infant Without Berth* and waits for the new rows
to appear (MutationObserver plus a timeout).

### Why a panel on the page instead of the toolbar popup?

Chrome doesn't let an extension open its toolbar popup by itself when a page
loads. So the same controls are shown in a panel inside the page. The panel
uses a closed Shadow DOM, so IRCTC's styles and scripts can't change or read
it. Use **Manage passengers & settings** in the panel, or the toolbar icon, to
edit profiles. The panel updates as soon as you save.

## Project structure

```
manifest.json          MV3 manifest (storage + scripting, host: www.irctc.co.in only)
background.js          service worker (ES module)
storage.js             storage schema, defaults, validation (shared ES module)
popup.html/.css/.js    popup UI
content.js             content-script entry (messages, SPA route watching)
content/dom-utils.js   event-correct setters, option matching, waitFor
content/detector.js    semantic field / row / control detection
content/filler.js      fill + clear orchestration, per-field report
content/panel.js       auto-opening Shadow-DOM panel (select → fill/clear → report)
content/autoflow.js    optional Continue/Continue/payment-method steps
icons/                 16/48/128 PNG icons (scripts/generate_icons.py regenerates them)
test/                  local mock page + popup harness (not loaded by the extension)
```

## Install (Load unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select this folder (the one that contains `manifest.json`).
4. Click the puzzle-piece icon in the toolbar and **pin** *IRCTC Smart Filler*.
5. If an IRCTC tab was already open, reload it once.

After you edit any file, click **↻ Reload** on the extension's card in
`chrome://extensions`, then refresh the IRCTC tab.

## Usage

1. Click the extension icon. Go to **Passengers** → **+ Add Passenger** → fill in the details → **Save Profile**.
2. (Optional) In **Groups**, choose **+ New Group**, name it, tick the members, then **Save Group**.
3. (Optional) In **Settings**, set contact details, preferences, insurance and payment mode, then **Save Settings**.
4. Log in to IRCTC yourself, search for a train, and pick a class/date to reach **Passenger Details**.
5. The **IRCTC Smart Filler** panel opens on the right side of the page by itself. Pick passengers or a group in it. (The toolbar popup's **Book** tab does the same thing.)
6. Click **Fill & Continue**, or **Fill Form** if auto-continue is off. If anything is marked **!** or **✕**, it doesn't continue: fix those items and click Continue yourself.
7. The extension moves through Review Journey and selects your payment method (default **BHIM/ UPI/ USSD → Paytm UPI**). Check the total, then click **Pay & Book**, or let the countdown click it if you turned that on.
8. Approve the payment in your UPI app.

**Clear Form** empties the passenger and infant rows (name, age, gender, berth,
food) and the coach number. Contact details, preferences, insurance and
payment mode are left as they are.

## Testing

### A. Offline, on the bundled mock page (no IRCTC login needed)

`test/mock/nget/booking/psgninput/index.html` mimics IRCTC's Angular +
PrimeNG markup. It has an autocomplete name field, native selects, a
PrimeNG dropdown, checkbox and radio buttons, and add-row links that
render after a delay. Its "model" only changes when real DOM events arrive.

```bash
python3 -m http.server 8765
```

Open `http://localhost:8765/test/mock/nget/booking/psgninput/`, then run this in DevTools:

```js
await __send({type: "FILL", payload: {
  passengers: [
    {type: "passenger", name: "Ravi Kumar", age: 34, gender: "Male", nationality: "India", berth: "Lower", food: "Veg"},
    {type: "infant_without_berth", name: "Baby Kumar", age: 1, gender: "Female"}
  ],
  contact: {mobile: "9123456789", overwriteExisting: false},
  preferences: {autoUpgrade: true, confirmBerths: true, reservationChoice: "two_lower", coachNumber: "B2"},
  insurance: "no", paymentMode: "upi"
}});
__mockModel   // every value should be reflected here
```

The popup UI can be previewed with in-memory stubs at
`http://localhost:8765/test/popup-harness.html`.

### B. On the real IRCTC page

1. Load the extension (see Install) and add 2–3 test profiles, including one infant without berth.
2. Log in to IRCTC and reach **Passenger Details** for any train. You don't need to pay; you can stop at the review page.
3. Check that the extension badge shows **ON** and the popup header says *Passenger page detected*.
4. Click **Fill Form** and confirm that:
   - the extension adds the right number of passenger and infant rows;
   - name, age, gender, nationality and berth are set in each row, and IRCTC shows no "required" error when you click into and out of a field;
   - contact details are only replaced if overwrite is enabled;
   - Auto Upgradation, confirm-berths, Reservation Choice, coach, insurance and payment mode match your Settings.
5. Click **Clear Form** and check that the rows are emptied.
6. Navigate away during a fill: the fill should stop with *You navigated away…*.
7. Try more than 6 passengers, or only an infant. Fill Form should be disabled with an explanation.
8. Read the report. Anything marked **!** means IRCTC showed a different option set, or the field wasn't offered for that train or class.

If IRCTC changes its markup and a field stops filling, the report names the
field. The fix usually goes in `KIND` / `isNameInput` / `isAgeInput`
(`content/detector.js`) or the option specs in `content/filler.js`.

## Privacy & security

- Data is stored only in `chrome.storage.local` on this device. There are no network requests, analytics or remote code.
- Permissions are `storage`, plus `scripting` (only to inject the content script into an IRCTC tab that was open before installation). The only host permission is `https://www.irctc.co.in/*`.
- The extension doesn't read browsing history and doesn't run on other sites.
- Passenger data is never written to the console. Reports contain field names, not values.
- No fields exist for passwords, OTPs, card numbers, UPI PINs or bank credentials.
- **Settings → Delete all saved data** wipes everything.

## Limitations (by design)

- No CAPTCHA, OTP or login automation, no payment details or UPI PIN, and no rate-limit or anti-bot bypass. The only automatic clicks are Continue (at most once per page, after a clean fill), the payment-method selection and, only if you turned it on, Pay & Book (once, after a countdown you can cancel). The payment is always approved by you in your UPI app.
- IRCTC enforces its own rules: names of 3–16 letters, a maximum of 6 passengers (4 for Tatkal), and class-specific berth or food options. The extension validates these in advance, but IRCTC has the final say.
- Child-berth, senior-concession and similar options that IRCTC shows after you enter an age are flagged in the report for you to choose manually.
