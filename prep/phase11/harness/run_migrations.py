import sys

if not sys.flags.isolated:
    sys.stderr.write(
        "MIGRATION-RUNNER-NOT-ISOLATED: this program must run under `python3 -I`. Without it the\n"
        "interpreter puts the script's own directory on `sys.path`, and that directory\n"
        "is the harness -- a planted `subprocess.py` or `hashlib.py` beside it would be\n"
        "imported by the program whose output the figure gate now treats as the only\n"
        "legitimate source of a figure. The driver always passes `-I`; a reviewer\n"
        "running this file by hand must too. Refusing rather than re-executing, because\n"
        "a re-exec reads the target a second time. (The coordinator's `C27-S2`: two of\n"
        "the pack's eight instruments refused without `-I` and six did not.)\n"
    )
    raise SystemExit(5)

import hashlib, os, re, subprocess, sys, json
import os
# The cluster is named by the environment so the harness can create its own
# on-target cluster and every script agrees on which one ran (finding P2-09).
SOCK=os.environ.get("P11_SOCK","/var/tmp/p11u/run"); PORT=os.environ.get("P11_PORT","55512"); DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
MIGDIR=sys.argv[1]
ROLE=sys.argv[2] if len(sys.argv)>2 else "daftar_migrator"
OWNER_TO=re.compile(r"\bOWNER\s+TO\s+(daftar_[a-z_]+)", re.I)

def strip(sql):
    sql=re.sub(r"/\*.*?\*/"," ",sql,flags=re.S)
    return "\n".join(re.sub(r"--.*$","",l) for l in sql.split("\n"))

def targets(sql):
    return sorted(set(OWNER_TO.findall(strip(sql))))

def psql(sqltext, role=ROLE, stop=True):
    cmd=[PSQL,"-h",SOCK,"-p",PORT,"-U",role,"-d",DB,"-q","-X"]
    if stop: cmd+=["-v","ON_ERROR_STOP=1"]
    cmd+=["-f","-"]
    r=subprocess.run(["su","postgres","-s","/bin/bash","-c"," ".join(f"'{c}'" if False else c for c in cmd)],
                     input=sqltext, capture_output=True, text=True)
    return r

# history table, as the runner creates it
r=psql("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());")
if r.returncode!=0:
    print("HISTORY TABLE FAILED rc=%d\n%s"%(r.returncode,r.stderr)); sys.exit(1)

files=sorted(f for f in os.listdir(MIGDIR) if f.endswith(".sql"))
applied=[]
for f in files:
    sql=open(os.path.join(MIGDIR,f),encoding="utf-8").read()
    sha=hashlib.sha256(sql.encode()).hexdigest()
    tg=targets(sql)
    body=["BEGIN;"]
    body+=['GRANT CREATE ON SCHEMA public TO "%s";'%t for t in tg]
    body+=[sql]
    body+=['REVOKE CREATE ON SCHEMA public FROM "%s";'%t for t in tg]
    body+=["INSERT INTO schema_migrations (name, sha256) VALUES ('%s','%s');"%(f,sha),"COMMIT;"]
    r=psql("\n".join(body))
    if r.returncode!=0:
        print("EARLIEST FAILURE: %s (rc=%d)"%(f,r.returncode))
        print("--- stderr ---"); print(r.stderr[:4000]); sys.exit(2)
    applied.append(f)
print("APPLIED %d/%d as %s"%(len(applied),len(files),ROLE))
print("LAST:", applied[-1] if applied else None)
