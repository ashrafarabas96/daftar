"""Phase 11 Pack B — the overlay's concurrency, two live backends, no sleep().

This file exists because the handoff at `b7ee445` carried Pack B's
concurrency as `UNMEASURED`, on the ground that the second party to the race
— the cache writer of patch request §3.6 — does not exist yet. The second
independent challenge measured it anyway and was right to: the second party
exists as a PRINCIPAL, because this pack's own end-state grants
`UPDATE (on_hand, last_movement_seq) ON stock_lot_levels TO
daftar_inventory_internal`. "The writer does not exist" was a statement
about the code; the law is about whoever holds the grant.

So the four races the challenger ran are carried HERE, in the author's own
harness, modelled on its `pb3race.py` (`challenge-b7ee445/`) and credited to
it. An author who leaves a measurement in the challenger's directory has a
law whose concurrency is proved by somebody else's script; when §3.6's
writer lands, this is the file that gets the fifth race.

Mechanics are `races.py`'s: two psql backends, each step awaited through a
sentinel, a blocked statement reported as an observation. Every race takes
its own movement document id so the ledger stays append-only, and the whole
file is re-runnable on one database: the lots carry a per-run tag and the
verdicts are read from the COMMITTED key-versus-cache comparison rather than
from a count that a previous generation would change.
"""
import subprocess, sys, threading, queue, time, random, os

SOCK=os.environ.get("P11_SOCK","/var/tmp/p11u/run"); PORT=os.environ.get("P11_PORT","55512"); DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
A='aaaaaaaa-0000-0000-0000-00000000000a'
TA='11111111-1111-1111-1111-111111111111'
WH='7c000000-0000-0000-0000-00000000007c'
P_LOT='7d000000-0000-0000-0000-00000000007d'

RUN=os.environ.get("P11_RUN_TAG") or "%06x" % random.randrange(16**6)
def U(tag,n): return f"{tag}{RUN}-0000-0000-0000-{n:012d}"
L1=U('c1',1); L2=U('c2',2)

class Session:
    def __init__(self, name, role="postgres"):
        self.name=name; self.n=0
        cmd=[PSQL,"-h",SOCK,"-p",PORT,"-U",role,"-d",DB,"-X","-q","-A","-t","-P","pager=off"]
        self.p=subprocess.Popen(["su","postgres","-s","/bin/bash","-c"," ".join(cmd)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.q=queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self.send(f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';")
    def _reader(self):
        for line in self.p.stdout: self.q.put(line.rstrip("\n"))
        self.q.put(None)
    def send(self, sql, timeout=8.0):
        self.n+=1; sent=f"__S{self.name}{self.n}__"
        self.p.stdin.write(sql.rstrip()+"\n"+f"SELECT '{sent}';\n"); self.p.stdin.flush()
        out=[]; t0=time.time()
        while True:
            try: line=self.q.get(timeout=0.25)
            except queue.Empty:
                if time.time()-t0>timeout: return out, True
                continue
            if line is None: return out, False
            if sent in line: return out, False
            # The challenger's own method limit, fixed rather than inherited:
            # a leaked sentinel in the captured output made one row's commit
            # column read `__S23__` instead of `ok`. Any sentinel of either
            # session is dropped from the captured lines.
            if line.strip() and not line.strip().startswith("__S"): out.append(line.strip())
    def close(self):
        try: self.p.stdin.write("\\q\n"); self.p.stdin.flush()
        except Exception: pass
        try: self.p.wait(timeout=3)
        except Exception: self.p.kill()

def admin(sql, must_succeed=True):
    r=subprocess.run(["su","postgres","-s","/bin/bash","-c"," ".join(
        [PSQL,"-h",SOCK,"-p",PORT,"-U","postgres","-d",DB,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-f","-"])],
        input=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';\n"+sql, capture_output=True, text=True)
    if must_succeed and r.returncode!=0:
        print("HARNESS SETUP FAILED — refusing to report a race it did not run:")
        print("  sql:", sql.strip()[:160]); print("  err:", r.stderr.strip()[:260]); sys.exit(2)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

V=admin(f"SELECT id FROM product_variants WHERE business_id='{A}' AND product_id='{P_LOT}' AND is_base;")[1].splitlines()[-1]
admin(f"""SET ROLE daftar_inventory_internal;
 INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,expiry_date,received_seq)
 VALUES ('{TA}','{A}','{L1}','{V}',catalog_identifier_norm('sku','R-{RUN}-1'),'R-{RUN}-1','2027-06-30',91),
        ('{TA}','{A}','{L2}','{V}',catalog_identifier_norm('sku','R-{RUN}-2'),'R-{RUN}-2','2028-06-30',92)
 ON CONFLICT DO NOTHING;""")

def receipt(doc, lot, qty, cache=True):
    """A lot-tracked receipt through the fixture command, optionally WITHOUT
    its cache write — which is the half that makes a transaction unlawful on
    its own and is the whole point of races R1/R1b."""
    b=(f"  m := fixture_adjust('{doc}','{WH}','{V}',{qty},0);\n"
       f"  SET LOCAL ROLE daftar_inventory_internal;\n"
       f"  INSERT INTO stock_lot_movements (tenant_id,business_id,stock_movement_id,warehouse_id,variant_id,lot_id,qty_delta)\n"
       f"    VALUES ('{TA}','{A}',m,'{WH}','{V}','{lot}',{qty});\n")
    if cache:
        b+=(f"  INSERT INTO stock_lot_levels (tenant_id,business_id,warehouse_id,variant_id,lot_id,on_hand,last_movement_seq)\n"
            f"    VALUES ('{TA}','{A}','{WH}','{V}','{lot}',{qty},0)\n"
            f"    ON CONFLICT (business_id,warehouse_id,variant_id,lot_id) DO UPDATE SET on_hand = stock_lot_levels.on_hand + {qty};\n")
    return "DO $pf$ DECLARE m UUID; BEGIN\n"+b+"END $pf$;"

CACHE_ONLY=lambda lot,d: (f"SET ROLE daftar_inventory_internal;\n"
                          f"UPDATE stock_lot_levels SET on_hand = on_hand + {d}\n"
                          f" WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V}' AND lot_id='{lot}';\nRESET ROLE;")

def state():
    k=admin(f"SELECT on_hand FROM stock_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V}';")[1].splitlines()[-1]
    c=admin(f"SELECT coalesce(sum(on_hand),0) FROM stock_lot_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V}';")[1].splitlines()[-1]
    return k,c

# The seed: one lawful receipt, so the races start from a state every law in
# the pack accepts rather than from an empty key.
admin("BEGIN;\n"+receipt(U('e1',11), L1, 3)+"\nCOMMIT;")
rows=[]; findings=0

def race(name, t1, t2, first, note=""):
    """The verdict is the COMMITTED key-versus-cache comparison. It is stated
    that way, and not as 'both were refused', because the property that
    matters is that neither transaction is rescued by the other's
    uncommitted work — a race can pass with both refused or both committed,
    and only the committed state says which happened lawfully."""
    global findings
    k0,c0=state()
    s1,s2=Session("1"),Session("2")
    s1.send("BEGIN;"); s2.send("BEGIN;")
    o1,b1=s1.send(t1); o2,b2=s2.send(t2)
    if first=="1":
        c1,_=s1.send("COMMIT;"); c2,_=s2.send("COMMIT;")
    else:
        c2,_=s2.send("COMMIT;"); c1,_=s1.send("COMMIT;")
    s1.close(); s2.close()
    k,c=state()
    one=lambda o: (" ".join(x for x in o if x)[:90] or "ok")
    consistent = (k==c)
    if not consistent: findings+=1
    rows.append((name,
                 f"T1 {one(o1)}{' [BLOCKED]' if b1 else ''} / T2 {one(o2)}{' [BLOCKED]' if b2 else ''}; {'T1' if first=='1' else 'T2'} commits first",
                 f"T1 commit: {one(c1)}; T2 commit: {one(c2)}",
                 f"before key {k0} = cache {c0}; after key {k} vs cache {c}" + (" — CONSISTENT" if consistent else " — **INCONSISTENT**"),
                 ("PASS" if consistent else "**FINDING**") + (" — "+note if note else "")))

# R1 / R1b. Each transaction is UNLAWFUL alone: T1 moves the key with its
# allocation and writes no cache, T2 writes only the cache. Their COMBINATION
# would look consistent, which is the shape a deferred check can be fooled by.
race("R1 a key-mover against a cache-writer, T1 commits first",
     receipt(U('e2',12), L1, 4, cache=False), CACHE_ONLY(L1,4), "1",
     note="neither may commit: each transaction is judged on what IT commits, not on the pair")
race("R1b the same pair, T2 commits first",
     receipt(U('e3',13), L1, 4, cache=False), CACHE_ONLY(L1,4), "2",
     note="neither may commit, in this arrival order either")
# R2 / R2b. Both transactions are LAWFUL alone, on the same key through
# different lots: they must both commit, and the key must equal the cache.
race("R2 two lawful movements on one key through different lots, T1 commits first",
     receipt(U('e4',14), L1, 4), receipt(U('e5',15), L2, 2), "1",
     note="both commit; the command's own lock on the key row serializes them")
race("R2b the same pair, T2 commits first",
     receipt(U('e6',16), L1, 4), receipt(U('e7',17), L2, 2), "2",
     note="both commit in the reverse order too")

print("| race | interleaving | commits | committed state | verdict |")
print("|---|---|---|---|---|")
for r in rows: print("| "+" | ".join(str(x).replace("|","/") for x in r)+" |")
print(f"\n{len(rows)} Pack B races run; {findings} finding(s).")
print("UNMEASURED still: a cache writer that moves the cache WITHOUT moving the key and is")
print("lawful doing it — no principal can be that today, because any one-sided change is")
print("refused on its own. That is §3.6's writer, and the lock order belongs with it.")
sys.exit(1 if findings else 0)
