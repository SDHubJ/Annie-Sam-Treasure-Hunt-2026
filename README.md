# Annie & Sam's Birthday Treasure Hunt 2026

Saturday 26 September, 7pm, starting at Pub on the Park, London Fields.
6 crews, 7 stops each on a pre-set route, finishing at The Perseverance.

- **Frontend:** static pages in `/docs`, served by GitHub Pages.
- **Backend:** Google Apps Script web app (`/apps-script`), bound to the Google Sheet.
- **Database:** the Google Sheet. It is the single source of truth for every team's progress.

```
/docs                  GitHub Pages site
  index.html           join page (the hidden QR at Pub on the Park opens this)
  hunt.html            live clue page (reads state from the backend, polls)
  checkin.html         landing page for every location QR (?c=<token>)
  assets/config.js     <- paste your Apps Script URL here
  assets/app.js        API calls, photo compression, helpers
  assets/style.css
/apps-script
  Code.gs              backend source (copy into script.google.com)
  appsscript.json      manifest (time zone, web app access, scopes)
```

**Nothing secret is in this repo.** Clue text, team routes and QR tokens live only in the Sheet and are
served one stop at a time. The repo can stay public.

---

## How it plays

1. Everyone scans the hidden start QR at Pub on the Park, which opens the join page.
2. They pick their crew. The phone remembers it (localStorage), and the Sheet holds the progress, so every
   phone in a crew shows the same clue.
3. Each clue is the text from column D of **3. Locations**, shown in the team's route order.
4. **QR stops** (Brat, Plonk, Netil 360, Auguste, Playground): scanning the hidden QR clears the stop and shows
   the next clue immediately. A QR scanned out of order is rejected, and the team's route isn't revealed.
5. **So Local:** the upload buttons appear with the clue. The team sends a photo or video, you approve it in
   the Sheet, and the next clue appears on their phones within about 7 seconds.
6. **Basketball Court:** the team finds the vinyl and scans its QR. That shows the task and unlocks the upload.
   **Saint Monday:** the team orders Bucky bombs, the bartender shows them the QR, and scanning it unlocks the
   video upload. Approval then works as above.
7. **The Perseverance:** scanning the final QR stamps the finish time. The first crew in is 1st.

---

## Setup (about 20 minutes)

### 1. Put the workbook into Google Sheets

1. Upload `Treasure_Hunt_2026_FINAL.xlsx` to Google Drive.
2. Open it with Google Sheets, then **File → Save as Google Sheets**. Work in the new copy (the green Sheets
   icon, not the .xlsx).
3. Keep the tab names exactly as they are: `1. Teams`, `2. Team Paths`, `3. Locations`.

You don't paste anything by hand. The setup script in step 2 adds everything:

| Tab | What setup adds |
|---|---|
| 1. Teams | `Started At`, `Finished At`, `Last Update` columns. It reuses your existing `Status`, `Current Index` and `Current Location` columns. The phone-numbers column is ignored. |
| 3. Locations | `QR Required`, `QR Token`, `Task Text`, `Check-in URL`, `QR Code` columns. It fills Brat's blank validation type as `answer`, and pre-fills the Basketball Court task text from your notes. |
| Approvals (new) | One row per upload, with a Status dropdown (Pending / Approved / Rejected), a note to the team, and a photo preview. |
| Log (new) | Every join, check-in, wrong scan, upload and decision, with timestamps. |
| Config (new) | Settings, plus the start QR for Pub on the Park. |

The **QR Required** column controls whether a stop needs a scan. Setup sets it to YES for answer stops, the
Basketball Court, Saint Monday and The Perseverance, and NO for So Local. You can change any of these.

### 2. Add the Apps Script

1. In the Google Sheet: **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
2. Delete everything in it and paste in the whole of `apps-script/Code.gs` from this repo.
3. Click the **gear icon (Project Settings)** and tick **Show "appsscript.json" manifest file in editor**.
   Go back to the editor (the `< >` icon), open `appsscript.json`, and replace its contents with
   `apps-script/appsscript.json` from this repo.
4. Click **Save** (the disk icon).
5. In the toolbar's function dropdown, choose **`setup`**, then click **Run**.
6. Google asks for permission. Choose your account. You'll see a screen saying "Google hasn't verified this
   app". This is normal for your own script: click **Advanced → Go to (project name) (unsafe) → Allow**.
7. The Execution log should end with `Setup done. Paths and locations check out.` If it lists problems
   instead (for example, a stop name that doesn't match the Locations tab), fix the Sheet and run `setup`
   again. It's safe to re-run.

Reload the Sheet. You'll now have a **Treasure Hunt** menu with Run setup, Refresh QR links, Clear cache,
and Reset all progress.

### 3. Deploy the backend

1. In the Apps Script editor: **Deploy → New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Set **Execute as: Me** and **Who has access: Anyone**. It must be "Anyone", not "Anyone with a Google
   account", so participants don't need to log in.
4. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).
5. Test it by opening `<that URL>?action=teams` in your browser. You should see the six team names as JSON.

**When you change Code.gs later**, use **Deploy → Manage deployments → pencil icon → Version: New version →
Deploy**. That keeps the same URL. "New deployment" would give you a new URL, and the site would keep calling
the old one.

### 4. Connect and publish the site

1. In this repo, edit `docs/assets/config.js` and paste the `/exec` URL into `API_URL`.
2. Commit and push.
3. On GitHub, go to **Settings → Pages**. Under **Build and deployment**, choose **Source: Deploy from a
   branch**, **Branch: main**, **Folder: /docs**, then **Save**.
4. After a minute or so the site is live at `https://sdhubj.github.io/Annie-Sam-Treasure-Hunt-2026/`.
   If GitHub shows a different address, put it in the Sheet's **Config** tab under `PAGES_BASE_URL` and run
   **Treasure Hunt → Refresh QR links**.

### 5. Print the QR codes

- **Start QR (Pub on the Park):** Config tab, `START_QR` row.
- **Location QRs:** Locations tab, `QR Code` column. There's one per stop that needs a scan, including the
  Basketball Court vinyl, the Saint Monday bartender's code and The Perseverance.

To print one full-size, right-click the image in the Sheet, or open its `Check-in URL` in any QR generator.
Scan each printed code with your phone before you hide it: joining any team should take you to the check-in
page.

To make a code unguessable again (for example, if someone leaks a photo of it), delete its `QR Token` cell,
run **Run setup**, then reprint that code.

### 6. Rehearse, then reset

1. Join a team on your phone, scan a couple of codes, upload a test photo, and approve it in the
   **Approvals** tab from the Google Sheets app.
2. When you're happy, use **Treasure Hunt → Reset all progress** (desktop only). Every team goes back to the
   start and Approvals and Log are cleared. Uploaded files stay in Drive.
3. If you edit clue text or paths, run **Clear cache**, or wait 2 minutes for changes to show on phones.

---

## On the night: approving uploads from your phone

- Every upload emails you with a link to the file and a link to the Approvals tab. Switch this off by
  clearing `NOTIFY_EMAIL` in Config.
- Open the Sheet in the **Google Sheets app** and go to the **Approvals** tab. Photos show as thumbnails;
  videos have a "Play video" link. Files are also in Drive under
  *Annie & Sam's Treasure Hunt 2026 — Uploads*, with one folder per team.
- Tap the **Status** cell and choose **Approved** or **Rejected**. For a rejection, you can type a reason in
  **Note to team** first; it appears on their phones.
- The team's phones pick the decision up on their next poll, within about 7 seconds. If you rejected
  something and change your mind, switch the row to Approved and the team moves on.

## Limits and known edges

- **Uploads:** 30MB per file. Photos are shrunk on the phone before sending, so they're tiny. The videos
  are the risk: a 30-second iPhone clip at 1080p is about 40–60MB and will be refused, with a message to
  record a shorter one. It's worth telling crews to keep clips short.
- **Previews:** with `PUBLIC_PREVIEWS = TRUE`, uploaded files are viewable by anyone who has the exact Drive
  link. This is what makes the thumbnails work in the Sheet. Set it to FALSE if you'd rather keep files
  private; you'll then approve by opening the Drive link instead of looking at the thumbnail.
- **No passwords, by design:** anyone can pick any crew on the join page. A phone that picks the wrong crew
  can switch using the link at the bottom of the clue page.
- **Apps Script quotas (free account):** about 100 emails a day, and a cap on simultaneous requests. Phones
  poll every 30 seconds normally and every 7 seconds only while waiting for approval, which keeps 34 phones
  well inside the limits.
