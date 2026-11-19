# Hospital Send-Out Report Builder

Replaces the "paste PCC data into ChatGPT" step. Staff open **one HTML file**, drop in the PCC CSV for a facility, and get the same 4-page report (building vs. provider) as a print-ready PDF. No install, no account, no AI, no BAA question: the data never leaves the computer.

**For staff:** use `dist/FPP-Hospital-Send-Out-Report.html`. Double-click it (Chrome, Edge or Safari), add the CSV, check step 3, press Print → Save as PDF.

## Why this design

| Concern | How it's handled |
|---|---|
| PHI must not go to ChatGPT | All math is plain code in the browser. A Content-Security-Policy in the file makes the browser **refuse every network request**; `build.js` also fails the build if any URL or network API appears. |
| Staff have different computers, no admin rights | A single file, works offline on Mac and Windows. Nothing to install. |
| Numbers must be trustworthy | Counting is deterministic (no LLM guessing) and covered by tests, plus an independent Python cross-check on sample data. |
| PCC exports change | Columns are matched by name aliases, with a manual mapping screen (remembered). Odd values (stay type, disposition) are shown with a dropdown to reclassify. |
| Bad data must not pass silently | Step 3 lists problems: unclassified stay types, unknown dispositions, missing admit dates, skipped rows, duplicates removed. |

Only column mappings and value choices are saved (browser `localStorage`). Resident data is never stored.

## The two PCC exports (confirmed against real files)

Add **both** files at once; the tool tells them apart by their columns.

| Export | Used for | Columns the tool uses |
|---|---|---|
| **Admission Log** (`admissionLog.csv`) | admissions, the rate denominator | `Date of Admission`, `MR#`, `Admission Status` (post-acute / long-term), `Primary Physician`, `Include Rate` |
| **Transfer Log** (`transferLog.csv`) | send-outs | `Date of Transfer`, `MR#`, `Purpose of Stay`, **`Ordered By`** (attribution; `ET` = Emergency Transfer), `Reason`, `Outcome`, `Length Of Stay`, `Planned`, `Included in Rates` |

Both must be filtered to **To/From Hospital** in PCC and cover the same dates. A leading `sep=,` line (Excel hint) is ignored. Other layouts (one combined file, differently named columns) work through the column-mapping screen.

## Definitions (confirm these match current practice)

- **Admissions** = admission-log rows in the period, attributed to the Primary Physician. Readmissions count. Rows with `Include Rate = No` are skipped (checkbox).
- **Send-out** = a transfer-log row in the period, attributed to **Ordered By** (not the primary physician). `ET` is shown as "Emergency Transfer" and gets no report of its own.
- **Duplicates:** PCC sometimes logs one transfer twice on the same day (once sent, once with the outcome). Same day + resident + ordering provider + reason = one send-out; the row with an outcome is kept.
- **RTH** = send-outs ÷ admissions in the same scope. It can exceed 100%.
- **Within 30 days** = `Length Of Stay` (days since last admission) ≤ 30. This matches PCC's own "Transferred to Hospital" 30-day message, which flips at 30/31 days. The window is editable.
- **Stay type** = `Purpose of Stay` on send-outs, `Admission Status` on admissions.
- **Reason:** matched to the 24 report categories, case-insensitive (`Gl bleeding` → GI bleeding). Blank reasons show as "Not recorded".
- **Outcome → disposition:** "Admitted, Inpatient" → Inpatient; "…Observation" → Observation; blank or "Other" → "Admitted; status uncertain"; "ED Visit Only" gets its own row (shown only when present).
- **Planned = Yes** transfers are counted unless the "skip planned" checkbox is ticked.

## Layout of this folder

```
src/core.js        parsing + every calculation + report sentences (pure, tested)
src/app.js         screens, review panel, report HTML
src/styles.css  src/template.html
build.js           inlines everything -> dist/FPP-Hospital-Send-Out-Report.html
test/core.test.js  node rth-report/test/core.test.js
sample/            FICTIONAL data + generator that prints independent expected totals
```

Rebuild after editing: `node rth-report/build.js`. Never put real exports in this repo (`.gitignore` blocks CSV/PDF outside `sample/`).

## Known limits / next steps

- Tested on one facility's de-identified admission and transfer logs (names are numeric IDs there). Other facilities' exports should behave the same; the mapping screen is the fallback.
- Open questions only the report owner can settle: how blank reasons and "Other"/blank outcomes were handled in past reports, whether ED-only visits count as send-outs, and whether planned transfers are excluded.
- One printout per provider is done by choosing the provider and saving the PDF (or print everything as one PDF). A batch "one PDF per provider per facility" button would need a small desktop wrapper.
- The 24 reason categories and the prose phrasing follow the August–October 2026 report; new categories appear as extra rows automatically.
