# 🗳️ בחירות 2026 · Israel Elections 2026

**תוצאות הבחירות לכנסת ה-26 בזמן אמת, בעברית ובאנגלית.**
**Live results of the 26th Knesset election, in Hebrew and English.**

GitHub Actions downloads the official Central Elections Committee (ועדת הבחירות המרכזית) result files every few minutes. It calculates seats with the Bader-Ofer method and the surplus agreements, then publishes a fast static site on GitHub Pages.

The seat calculation is ported from [amiram/Elections](https://github.com/amiram/Elections). It is verified against the official 2022 result: `npm test`.

---

## עברית

### מה יש באתר
- **הרכב הכנסת**: חצי עיגול של 120 מושבים בצבעי המפלגות.
- **גושים**: הקואליציה היוצאת, האופוזיציה והמפלגות הערביות, מול קו הרוב של 61.
- **מפלגות**: קולות, אחוזים, מנדטים, שינוי מ-2022, וכמה קולות חסרים למנדט הבא.
- **בונה קואליציות**: בוחרים מפלגות ובודקים אם יש 61.
- **התפתחות הספירה**: מנדטים לאורך הלילה.
- **תוצאות לפי יישוב**, עם חיפוש.
- מצב כהה ובהיר, עברית (RTL) ואנגלית (LTR), ותצוגה מותאמת לנייד.
- עדכון אוטומטי כל דקה. לפני סגירת הקלפיות מוצג שעון עצר, ויש גם **מצב הדגמה** (`?demo=1`).

### הקמה (פעם אחת)
1. צרו ריפו חדש וריק ב-GitHub, למשל `israel-elections-2026`.
2. דחפו את הקוד:
   ```bash
   git remote add origin https://github.com/<USER>/israel-elections-2026.git
   git push -u origin main
   ```
3. **Settings → Pages → Source: GitHub Actions**.
4. **Settings → Actions → General → Workflow permissions: Read and write permissions**.
5. בלשונית **Actions** הריצו את **Update results & deploy** (Run workflow). האתר יעלה בכתובת `https://<USER>.github.io/israel-elections-2026/`.

### בליל הבחירות
- הריצה המתוזמנת פועלת בכל 5 עד 15 דקות. לעדכון רציף אפשר להריץ ידנית את ה-workflow עם `loop_minutes = 55`, וכך הוא בודק כל דקה במשך כמעט שעה.
- **אם ועדת הבחירות חוסמת את שרתי GitHub** (הם בארה״ב), הריצו מהמחשב שלכם בישראל:
  ```bash
  node scripts/fetch-results.mjs --watch 60 --push
  ```
  הסקריפט מוריד, מחשב ודוחף ל-GitHub בכל שינוי, והאתר מתעדכן מיד.
- גיבוי ידני: הורידו את `expc.csv` מאתר ועדת הבחירות, שימו אותו בתיקייה `raw/` ודחפו.
- בסיום: הריצו את ה-workflow עם `final` מסומן, או `node scripts/fetch-results.mjs --final --push`.

---

## English

### Setup (once)
1. Create a new, empty GitHub repo, e.g. `israel-elections-2026`.
2. Push: `git remote add origin https://github.com/<USER>/israel-elections-2026.git && git push -u origin main`
3. **Settings → Pages → Source: GitHub Actions**
4. **Settings → Actions → General → Workflow permissions: Read and write**
5. **Actions → Update results & deploy → Run workflow**. The site goes live at `https://<USER>.github.io/israel-elections-2026/`.

### Election night
- The scheduled run fires every 5–15 minutes and polls for about 4 minutes each time. For continuous updates, run the workflow manually with `loop_minutes = 55`.
- **If the committee blocks GitHub's US runners**, run the fetcher from a machine in Israel: `node scripts/fetch-results.mjs --watch 60 --push`.
- Manual fallback: drop `expc.csv` / `expb.csv` from the committee site into `raw/` and push.
- When counting ends: run the workflow with `final` checked, or `node scripts/fetch-results.mjs --final --push`.

### How it works
```
CEC files (media26.bechirot.gov.il/files/expc.csv, expb.csv)
   └─► scripts/fetch-results.mjs ── parse CSV (UTF-8 / windows-1255), seats via scripts/seats.mjs
          └─► site/data/results.json, history.json, localities.json ── commit & push
                 └─► GitHub Pages (site/) ── the browser polls every 60 s; it also reads raw.githubusercontent.com
                     so new data shows up before Pages redeploys
```

| Path | Purpose |
|---|---|
| `config/election-2026.json` | Source URLs (tried in order), threshold, poll-closing time, **surplus agreements** |
| `config/parties-2026.json` | Ballot letters → Hebrew/English names, leader, color, bloc, 2022 seats |
| `scripts/seats.mjs` | Bader-Ofer allocation and votes to gain/lose a seat (`--test` checks it against 2022) |
| `scripts/fetch-results.mjs` | Fetcher (`--watch N`, `--duration M`, `--push`, `--final`, `--demo`) |
| `scripts/test-parse.mjs` | Parses a CSV with the real 2026 column header, end to end |
| `site/` | Static site (no build step): `index.html`, `styles.css`, `app.js`, `i18n.js` |

### Local preview
```bash
npm run demo        # regenerate the demo data
npm start           # http://localhost:8080   (demo: http://localhost:8080/?demo=1)
npm test
```

### Data notes
- `expb.csv` already exists on the committee's server with the official 2026 column header (published 2026-10-13). It lists 38 ballot-letter columns. `expc.csv` will appear once counting starts.
- Party names, letters and surplus agreements come from Wikipedia (he/en) as of 2026-10-27. The main lists' letters match the official file header. Hebrew names of very small lists are translations and may differ slightly from the ballot. A letter with no entry is shown as "רשימה <letters>".
- Bloc grouping is editorial: `config/parties-2026.json` → `bloc`.
- **Unofficial.** Only the Central Elections Committee's published results are binding.
