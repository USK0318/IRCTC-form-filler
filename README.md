# IRCTC Form Filler (Chrome Extension)

Save your passengers once, then auto-fill the IRCTC passenger booking form.

## Two-step flow

**Step 1 — Save passengers (do this first):**
Click the extension icon in the Chrome toolbar. A popup opens where you add each
passenger (name, age, gender, berth, country) and click **Save passenger**. The
list is stored permanently. You can edit or delete anyone later.

**Step 2 — Fill the form:**
On the IRCTC passenger page
(`https://www.irctc.co.in/nget/booking/psgninput`), a panel appears on the
right listing your saved passengers with checkboxes. Tick who you want, then
click **Fill Form**. It:

1. Adds the required rows and fills each passenger's name, age, gender, berth,
   and country.
2. Checks **Consider for Auto Upgradation**.
3. Selects **Pay through BHIM/UPI**.
4. Clicks **Continue**.

The last three are toggle checkboxes in the panel.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. **Pin the extension** (puzzle-piece icon → pin) so you can open the popup.
5. Click the icon → add your passengers.
6. Go to the IRCTC passenger page and use the panel.

> After changing any file here, click the **↻ reload** icon on the extension
> card in `chrome://extensions`, then refresh the IRCTC tab.

## Files

- `manifest.json` — MV3 config; content script matches the whole `nget` app.
- `content.js` — the on-page panel + fill logic (Angular/PrimeNG-aware, handles
  the single-page-app routing).
- `panel.css` — page panel styles.
- `popup.html` / `popup.css` / `popup.js` — the saved-passenger manager.

## Notes / limitations

- IRCTC's markup changes periodically. Selectors are defensive with fallbacks;
  if a step is skipped, check the console (`[IRCTC Filler]` logs) and the panel
  status line.
- CAPTCHA, OTP, and the final payment are **not** automated — do those yourself.
