# FPP Team (prototype)

A mobile-first, installable web app (PWA) for Florida Physician Partners staff. It covers SNF assignments, time off with provider coverage, a time clock for hourly staff, required training courses, and checklists/forms. No patient data (PHI) belongs in this app.

## Run it

```
python3 -m http.server 8080
```

Open http://localhost:8080 and sign in as a demo user. "Admin User" sees the manager view; everyone else sees the staff view.

## Branding

Colors come from the FPP logo: forest green `#2A4C35` (buttons, links, headings), leaf green `#599A43` (header rule, accents) and rule gray `#C5C5C4`. They're defined once as CSS variables at the top of `styles.css`, with a matching dark mode. The logo and app icons are in `assets/`:

- `logo.svg`: the full logo. Its lettering (Baskerville SemiBold and Helvetica) has been converted to vector outlines, so it looks the same on devices without those fonts.
- `icon.svg`: the round doctor mark on a white circle, used as the browser-tab icon.
- `icon-*.png`: home-screen and install icons, since phones still require PNG for those.

## Features

- **SNF assignments:** every SNF lists its region, its assigned providers and staff, who is out today, and who is covering whom. Admins add/edit SNFs, choose each one's region (1–6) and assign people.
- **Regional chart (SNFs tab → Regional chart):**
  - **Layout:** Florida Physician Partners at the top, Regions 1–6 below, and each region's SNFs listed underneath. It becomes a grid on smaller screens.
  - **Status colors:** each SNF is colored by its coverage on the chosen date: all providers in, provider out but covered, or coverage needed (also shown when no provider is assigned). Regions with problems are flagged.
  - **SNF details:** selecting an SNF shows its providers and whether each is in or out, who's seeing an absent provider's patients, provider time off in the next 30 days, and other staff. Admins can assign coverage or edit the SNF from there.
  - **Next 30 days:** a list at the top shows every SNF needing coverage in the next 30 days.
- **On-call schedule (Calendar tab → On-call):** see On-call below.
- **Calendar export (admins):** "Export CSV" on the Calendar tab downloads the time-off calendar, the on-call calendar, or both as separate files, for any date range (defaults to the month shown).
  - **Time-off options:** filter by SNF, include pending requests, and choose one row per request or one row per day off. Each row lists coverage by SNF and flags any that still need coverage.
  - **On-call file:** uses the same Date / Shift / Provider columns as the import template, so it can be edited and imported back.
- **What counts as "coverage needed":** a provider has approved time off and either no covering provider was picked for that SNF, the SNF was added to them after approval, or the covering provider is out too. The Requests tab's "Coverage needed" list uses the same rule.
- **Time off requests:** staff pick a type and dates. Providers can suggest a covering provider.
- **Admin review:** opening a request shows a calendar of the requested dates (with other approved and pending time off), conflicts at the person's SNFs, and one coverage picker per SNF. Providers already out are disabled. Approving requires coverage for every SNF.
- **Calendar:** month view of approved time off (admins also see pending). Covering providers show as "↳ Name". Filter by SNF, and tap a day to see who is out and who sees whose patients at each SNF.
- **Coverage safety net:** if approving a provider's time off removes someone's coverage (they were covering another provider), that coverage is flagged "needs coverage" and appears under Requests to reassign. Cancelling approved time off removes its coverage.
- **Time clock (non-provider staff):** everyone outside the Provider group clocks in and out from their Home screen and sees their weekly hours. There's no location tracking. Providers and app managers don't clock in.
- **Timesheets (admin "Hours" tab):** weekly hours per person, overtime over 40 hours, and missed clock-outs flagged. Admins can add, edit or delete punches (edited punches are tagged) and export CSV for payroll.
- **Punch fix requests:**
  - **Asking for a fix:** hourly staff use "Forgot to clock in or out?" on their clock card to add a missing punch or correct an existing one, with a reason. A missed clock-out from an earlier day shows a banner with a "Request fix" button.
  - **Missed clock-outs:** an open punch from an earlier day counts 0 hours until it's fixed, and doesn't stop the person clocking in today.
  - **Who sees requests:** app managers see them in the Requests tab (counted in its badge) and in a banner on Hours.
  - **Approving or denying:** managers can adjust the times before approving, which updates the timesheet and tags the punch "edited." Denying requires a note.
  - **Tracking:** employees see each request's status and the office's note.
- **Forms and checklists:** see Forms below. Opening/closing checklists live on the Forms tab.
- **Courses (training):** see below.
- **Team:** admins add and edit staff with job title, group, reporting line, phone, email, address, date of birth and date of employment. The Team list shows tap-to-call phone, tap-to-email address and hire date; address and date of birth appear only in the edit form.
- **Org chart:**
  - **Viewing:** the Team tab has a People / Org chart toggle. Cards are colored by group, and admins select a card to edit that person.
  - **Adding someone:** "Add staff" requires choosing who the new person reports to (or the top of the chart). It can also move existing people under them, for a new manager taking over a team.
  - **Changing someone:** editing a person can change who they report to; people below them are left out of the choices, so the chart can't loop.
  - **Removing someone:** the admin chooses where that person's direct reports go. The default is the removed person's manager, and promoting one of the reports into the spot is also an option.
  - **Employees:** a "My team" card on Home shows who they report to and their direct reports, and links to a read-only org chart.

## Groups

Every employee belongs to one group: **Provider**, **Billing**, **Staff** or **Admin**. Admins change groups from the Team tab, which lists people by group. Groups decide:

- **Courses:** a course is required for the groups it's assigned to, or for everyone if no group is checked.
- **Coverage:** people in Provider need another provider to cover their SNF patients when they take time off.
- **Time clock:** everyone except Providers and app managers clocks in.

A person's job title (for example Medical Assistant) is separate and only for display. Being in the Admin group doesn't give someone access to manage the app; only "Admin User" has that in this prototype.

## On-call

| When | Who | Where it comes from |
|---|---|---|
| Mon–Fri 5am–5pm | Each SNF's assigned providers, or whoever covers them during time off | SNF assignments and time-off coverage (nothing to schedule) |
| Sun–Thu 5pm–5am | The full-time on-call NP | Default, editable per night |
| Fri 5pm–Sat 5pm | One provider for the whole practice | Weekend rotation |
| Sat 5pm–Sun 5pm | One provider for the whole practice | Weekend rotation |

- **Calendar:** each day shows that evening's on-call shift; your own shifts are outlined. Selecting a day shows the on-call person, the daytime coverage by SNF, and who's off. Admins can change the on-call person right there.
- **CSV import (admins):**
  - **Template:** "Download template" gives a CSV for the month shown (columns: Date, Day, Shift, Provider), prefilled with the current schedule, to fill in with Excel or Google Sheets.
  - **Importing:** "Import CSV" shows a preview before anything changes. Rows with bad dates, the wrong shift for that day or unknown names are skipped, and anyone on call during their own time off is flagged.
  - **What it accepts:** dates as YYYY-MM-DD or M/D/YYYY. Names match with or without "Dr." and credentials like NP or MD, by email, or by a unique last name.
- **Draft rotation:** fills the month's weekend shifts in rotation order, continuing from the last scheduled weekend and skipping anyone with approved time off, and gives nights to the on-call NP. It can fill only the empty shifts or redraft the whole month.
- **Conflicts:** "Needs attention" lists unassigned shifts and anyone on call during approved time off. Approving time off also warns when the person has on-call shifts in those dates.
- **Providers:** a "My on-call" card on Home lists their shifts for the next 30 days.
- **On-call settings:** choose the on-call NP and who's in the weekend rotation.

## Forms

| Form | Who | Schedule | Admin workflow |
|---|---|---|---|
| End of Day Report | Providers | Every workday | Tracked; reports with unfinished tasks need follow-up |
| Monthly Mileage Report | Providers | Monthly, due the 5th | Approve, return or deny, then mark paid |
| Facility Incident Report | Everyone | As needed | Mark reviewed or ask for more info |
| Expense Reimbursement | Everyone | As needed | Approve, return or deny, then mark paid |
| Supply / Equipment Request | Everyone | As needed | Approve, return or deny |

- **End of Day Report:**
  - **Patients seen:** a count for each of the provider's SNFs, plus "other locations."
  - **Task checklist:** admins edit the list under EOD & mileage settings. Any task left unchecked needs a note saying what's left and when it will be done.
  - **Notes:** an optional note for the office.
  - **Which days:** reports are expected on the required weekdays (default Monday to Friday), skipping approved time off.
- **What staff see:** a "Forms due" card on Home and the Forms tab lists today's EOD, missed EODs, mileage due and anything returned for changes. Returned forms show the office's note and can be fixed and resubmitted.
- **Mileage:** a trip log (date, from, to, purpose, miles) with live totals, reimbursed at a rate the admin sets. You can also report "no business mileage."
- **Expense receipts:** phone photos are shrunk to about 1400px JPEGs before saving.
- **Admin Forms tab:**
  - **Review queue:** "Needs review" for everything waiting on a decision.
  - **Payment:** an "awaiting payment" list with a running total.
  - **End of Day tracker:** a weekly grid of providers against days, showing patients, late, missing, time off and follow-ups, with weekly totals.
  - **All submissions:** filter by form, status or person, and export to CSV.
- **Review rules:** returning or denying requires a note, and every action is recorded in the form's history.

## Courses

Each course is a set of slides followed by an optional quiz. Published courses are required for the groups they're assigned to (or everyone) and are tracked per person.

- **Staff:** a Courses tab and a "Required training" card on Home show what's due, overdue, in progress or done. Courses resume where you left off. You must go through every slide before the quiz, and arrow keys move between slides. Quiz questions and options are shuffled on each attempt. After an attempt, missed questions show the correct answer and an explanation. Retakes are unlimited, and passing records completion.
- **Admins:**
  - **Course settings:** create and edit courses (assigned groups, due-within days, pass score, renewal period, draft or published).
  - **Preview:** preview a course without recording anything.
  - **Compliance tracking:** a compliance matrix shows every person against every course; select a status to see attempt history or reset someone's progress.
  - **Own training:** admins who are assigned courses (for example through the Admin group) see "My required training" on the Courses tab, and their completions are tracked like everyone else's.
  - **Export:** CSV export of all training records.
- **Renewals:** courses with a renewal period (for example annual HIPAA) show "Renew soon" 30 days before expiry and "Expired" after.
- **New versions:** when editing a published course, you can mark it as a new version so everyone has to complete it again.

The sample courses (HIPAA basics, bloodborne pathogens, getting started) are starting points written for this prototype. Have your compliance lead review or replace them before relying on them.

### Writing course content

Slides are plain text, which makes it easy to paste from PowerPoint's outline view. Separate slides with a line containing only `---`:

```
# Slide title
A paragraph of text with **bold** and *italic*.
- Bullet point
1. Numbered step
> Highlighted key point
![Description of image](https://example.com/image.png)
@video https://www.youtube.com/watch?v=VIDEO_ID
---
# Next slide
```

Quiz questions start with `Q:`. Mark the one correct option with `*` and the others with `-`. An optional `>` line explains the answer:

```
Q: How should you dispose of paper that contains PHI?
- Regular trash
* A locked shred bin
> Shredding keeps PHI from being read by anyone else.
```

## Not production-ready yet

- Data lives in browser `localStorage`; there is no server, so devices don't sync. Browsers cap this at about 5 MB, which limits how many receipt photos fit; a real backend with file storage removes that limit.
- There are no email or push reminders yet; due and missing forms only show inside the app.
- Sign-in is a demo picker with no passwords.
- SNF names and people are placeholders.

## Suggested next steps

1. Backend and real auth (for example Supabase or Firebase with SSO and role rules).
2. Email/push notifications for requests, approvals and new coverage assignments.
3. Per-SNF rounding days, so coverage can be checked against who rounds when.
4. Half-days, recurring time off, and a minimum-notice rule.
5. Credential and license expiration tracking.
