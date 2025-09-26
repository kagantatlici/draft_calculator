import re, json, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'booklet.txt'
OUT = ROOT / 'data' / 'tanks.json'
OUT.parent.mkdir(parents=True, exist_ok=True)

txt = SRC.read_text(encoding='utf-8', errors='ignore')

entries = []

# Ballast examples lines contain patterns like:
# "NO.1 W.B.TK(P)  (100t)  1.0250  1833.3 6.408  65.051"
# More permissive: capture line and then try to find trailing float as LCG
name_pat = re.compile(r"\b(NO\.?\s*\d+\s+(?:W\.B\.TK|CARGO\s+TK)\s*\([PS]\))", re.IGNORECASE)
line_pat = re.compile(r"^.*(NO\.?\s*\d+\s+(?:W\.B\.TK|CARGO\s+TK)\s*\([PS]\).*)$", re.MULTILINE | re.IGNORECASE)

for m in line_pat.finditer(txt):
    line = m.group(1)
    nm = name_pat.search(line)
    if not nm:
        continue
    name = re.sub(r"\s+", " ", nm.group(1)).strip()
    # take last float on the line as LCG candidate
    floats = re.findall(r"-?\d+\.\d+", line)
    if not floats:
        continue
    try:
        lcg = float(floats[-1])
    except Exception:
        continue
    # classify
    ttype = 'cargo' if 'CARGO' in name.upper() else ('ballast' if 'W.B.TK' in name.upper() or 'F.P.TK' in name.upper() else 'other')
    entries.append({"name": name, "lcg": lcg, "type": ttype})

# Add F.P. TK (C)
mfp = re.search(r"\bF\.P\.\s*TK\s*\(C\)[^\n]*?(\d+\.\d{1,3})\s*$", txt, re.MULTILINE)
if mfp:
    entries.append({"name": "F.P. TK (C)", "lcg": float(mfp.group(1)), "type": "ballast"})

# Slop explicit if missed
if not any('SLOP' in e['name'].upper() for e in entries):
    msl = re.search(r"SLOP\s+TK\s*\([PS]\)[^\n]*?(-?\d+\.\d{1,3})\s*$", txt, re.MULTILINE)
    if msl:
        entries.append({"name": "Slop TK (P)", "lcg": float(msl.group(1)), "type": "cargo"})
        entries.append({"name": "Slop TK (S)", "lcg": float(msl.group(1)), "type": "cargo"})

# Deduplicate by (name)
seen = {}
for e in entries:
    seen[e['name']] = e

entries = list(seen.values())
entries.sort(key=lambda x: (x['type'], x['name']))

OUT.write_text(json.dumps({"tanks": entries}, indent=2), encoding='utf-8')
print(f"Wrote {OUT} with {len(entries)} tanks")
