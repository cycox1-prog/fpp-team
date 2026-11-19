#!/usr/bin/env python3
"""Generate a FICTIONAL sample facility export (no real residents) and print the totals
the report should show, computed independently of the JavaScript, for cross-checking.

    python3 rth-report/sample/make_sample.py
"""
import csv, random, datetime as dt, os
from collections import Counter

rng = random.Random(7)
HERE = os.path.dirname(os.path.abspath(__file__))

FIRST = ["Alma","Bruno","Cora","Dev","Elio","Faye","Gil","Hana","Ivo","Jada","Kemal","Lena","Milo","Nora","Omar",
         "Pia","Quinn","Rhea","Sol","Tess","Uri","Vera","Wes","Xena","Yara","Zane"]
LAST = ["Abbott","Brandt","Calloway","Dalton","Ellery","Fenwick","Garrity","Holloway","Ingram","Jessup","Kessler",
        "Lombardi","Mercer","Nakamura","Oduya","Pruitt","Quarles","Renner","Sutter","Thackeray","Underhill",
        "Vandermeer","Whitlock","Yarrow","Zeller"]
PROVIDERS = [("Rivera, Alex MD", 0.45), ("Okafor, Dana NP", 0.30), ("Lindqvist, Sam NP", 0.25)]
REASONS = ["Altered mental status","Other","Low hemoglobin / hematocrit","GI bleeding","Fall",
           "Shortness of breath (bronchitis, pneumonia)","Abnormal vital signs (low/high BP, high respiratory rate)",
           "Abdominal pain","Respiratory infection","Chest pain","Abnormal X-ray","Seizure","Skin wound or ulcer",
           "Behavioral symptoms (e.g. agitation, psychosis)","Uncontrolled pain","Stroke / TIA / CVA"]
DISPS = ["Inpatient"] * 8 + ["Observation"] * 2 + ["Admitted"]

START, END = dt.date(2026, 8, 1), dt.date(2026, 10, 1)
used = set()
def name():
    while True:
        n = f"{rng.choice(LAST)}, {rng.choice(FIRST)}"
        if n not in used:
            used.add(n); return n
def prov():
    return rng.choices([p for p, _ in PROVIDERS], [w for _, w in PROVIDERS])[0]
def d(lo, hi):
    return lo + dt.timedelta(days=rng.randint(0, (hi - lo).days))
fmt = lambda x: x.strftime("%m/%d/%Y")

rows, residents = [], []
# New admissions: 60 days of the period plus a 45-day lookback
for i in range(150):
    stay = "Post-Acute" if rng.random() < 0.78 else "Long-Term"
    day = d(START - dt.timedelta(days=45), END)
    r = dict(name=name(), id=str(1000 + i), prov=prov(), stay=stay, admit=day)
    residents.append(r)
    rows.append(["Admission", fmt(day), r["name"], r["id"], r["prov"], stay, "", "", ""])
# Long-stay residents who were already in house (no admission event in the file)
for i in range(25):
    r = dict(name=name(), id=str(2000 + i), prov=prov(), stay="Long-Term", admit=START - dt.timedelta(days=rng.randint(60, 900)))
    residents.append(r)

sends = []
def sendout(res, date, provider=None):
    reason = rng.choice(REASONS)
    p = provider or ("Emergency Transfer" if rng.random() < 0.18 else res["prov"])
    disp = rng.choice(DISPS)
    sends.append(dict(res=res, date=date, prov=p, reason=reason, disp=disp, stay=res["stay"]))
    rows.append(["Send-out", fmt(date), res["name"], res["id"], p, res["stay"], reason, disp, fmt(res["admit"])])

pool = [r for r in residents if r["admit"] <= END]
for res in rng.sample(pool, 52):
    lo = max(res["admit"], START)
    if lo > END: continue
    sendout(res, d(lo, END))
for res in rng.sample([s["res"] for s in sends], 6):           # repeat send-outs
    prev = [s for s in sends if s["res"] is res][0]
    lo = prev["date"] + dt.timedelta(days=3)
    if lo <= END:
        sendout(res, d(lo, END))

# A few messy rows, like a real export
rows.append(["Discharge", fmt(START + dt.timedelta(days=9)), "Abbott, Alma", "9999", "Rivera, Alex MD", "", "", "", ""])
rows.sort(key=lambda r: dt.datetime.strptime(r[1], "%m/%d/%Y"))

out = os.path.join(HERE, "sample_facility.csv")
with open(out, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["Event Type", "Event Date", "Resident Name", "Resident ID", "Provider", "Stay Type", "Reason", "Disposition", "Resident Admit Date"])
    w.writerows(rows)

# ---- independent expected values ------------------------------------------------------
inr = lambda x: START <= x <= END
adm = [r for r in residents if r["id"].startswith("1") and inr(r["admit"])]
sin = [s for s in sends if inr(s["date"])]
within = lambda s: (s["date"] - s["res"]["admit"]).days <= 30
print("wrote", out)
print("admissions in range:", len(adm), "| post-acute:", sum(r["stay"] == "Post-Acute" for r in adm), "| long-term:", sum(r["stay"] == "Long-Term" for r in adm))
print("send-outs:", len(sin), "| PA:", sum(s["stay"] == "Post-Acute" for s in sin), "| LT:", sum(s["stay"] == "Long-Term" for s in sin))
print("PA within 30:", sum(s["stay"] == "Post-Acute" and within(s) for s in sin), "| LT within 30:", sum(s["stay"] == "Long-Term" and within(s) for s in sin))
print("residents with >=1 send-out:", len({s["res"]["id"] for s in sin}))
print("by provider:", dict(Counter(s["prov"] for s in sin)))
print("top reasons:", Counter(s["reason"] for s in sin).most_common(3))
rep = Counter(s["res"]["id"] for s in sin)
print("repeat residents:", sum(1 for v in rep.values() if v >= 2))
print("dispositions:", dict(Counter({"Admitted": "Admitted; status uncertain"}.get(s["disp"], s["disp"]) for s in sin)))
