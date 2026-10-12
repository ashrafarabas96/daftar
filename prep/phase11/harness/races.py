"""Phase 11 Pack A — real concurrency, two live backends, no sleep().

V2 section 18: "uniqueness and immutability need concurrency even without a
deferred trigger ... prove the simultaneous duplicate combination, an axes
change against a variant insert, and an attributes change against the first
stock movement, with real concurrency and a result matrix. 'No locks,
therefore no concurrency' is not a proof."

That sentence corrects this preparation's own proof document, which had
written exactly that sentence. So the three races are run here.

Mechanics. Two psql processes, each a real backend with its own transaction.
Steps are interleaved by the harness and each is awaited through a sentinel,
so the ordering is the test rather than a timing hope; a statement that
blocks on a lock blocks its process, and the harness reports that as an
observation. Every race gets its OWN product and its own variant ids, and
nothing is deleted between races — because `stock_levels_retain()` refuses
to delete a stock key at all ("a stock key, once created, is retained with
its history"), so a "clean slate" inside one database is not available. The
first version of this harness tried to delete its way back to a clean state,
its setup failed silently, and two of the three races then measured
something other than what they claimed. Hence: append-only world, and every
setup statement is checked.
"""
import subprocess, sys, threading, queue, time

SOCK="/var/tmp/p11s/run"; PORT="55511"; DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
A='aaaaaaaa-0000-0000-0000-00000000000a'
TA='11111111-1111-1111-1111-111111111111'
PR='4a000000-0000-0000-0000-00000000004a'  # race A product
PB='4b000000-0000-0000-0000-00000000004b'  # race B product
PC='4c000000-0000-0000-0000-00000000004c'  # race C product
PD='4d000000-0000-0000-0000-00000000004d'  # race B2 product (the reverse arrival order)

class Session:
    def __init__(self, name, role="postgres"):
        self.name=name
        cmd=[PSQL,"-h",SOCK,"-p",PORT,"-U",role,"-d",DB,"-X","-q","-A","-t","-P","pager=off"]
        self.p=subprocess.Popen(["su","postgres","-s","/bin/bash","-c"," ".join(cmd)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.q=queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self.n=0
        self.send(f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';")
    def _reader(self):
        for line in self.p.stdout: self.q.put(line.rstrip("\n"))
        self.q.put(None)
    def send(self, sql, timeout=6.0):
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
            if line.strip(): out.append(line.strip())
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
        print("  sql:", sql.strip()[:140]); print("  err:", r.stderr.strip()[:240]); sys.exit(2)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

def product(pid, sku):
    # One transaction: `product_requires_translation()` refuses a product
    # that reaches the end of its transaction with no name in any locale —
    # the keep-one guarantee the catalog's translation row tables carry and
    # which this preparation's original `translations JSONB` design would
    # have lost. Measured here by tripping it.
    admin(f"""BEGIN;
      INSERT INTO products (business_id,id,sku,status,base_price_minor,price_currency) VALUES ('{A}','{pid}','{sku}','active',0,'ILS');
      INSERT INTO product_translations (business_id,product_id,locale,name) VALUES ('{A}','{pid}','ar','سباق');
      INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{pid}','size',1),('{A}','{pid}','color',2);
    COMMIT;""")

V=lambda pid,vid,attrs: (f"INSERT INTO product_variants (business_id,id,product_id,attributes) "
                         f"VALUES ('{A}','{vid}','{pid}','{attrs}'::jsonb);")
rows=[]
def record(*r): rows.append(r)

# ── RACE A ──────────────────────────────────────────────────────────────────
product(PR,'RACE-A')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
s1.send(V(PR,'c1000000-0000-0000-0000-00000000000a','{"size":"s","color":"red"}'))
o2,blocked=s2.send(V(PR,'c2000000-0000-0000-0000-00000000000a','{"size":"s","color":"red"}'))
s1.send("COMMIT;")
o2b,_=s2.send(""); c2,_=s2.send("COMMIT;")
s1.close(); s2.close()
_,n,_=admin(f"SELECT count(*) FROM product_variants WHERE business_id='{A}' AND product_id='{PR}';")
err=" ".join(o2+o2b+c2)
ok = n=="1" and "product_variants_matrix_uq" in err
record("A  duplicate combination",
       "INSERT {size:s,color:red}, then COMMIT",
       "INSERT the same combination, concurrently",
       f"T2 blocked while T1 held the speculative insert: {blocked}. Rows after both: {n}. T2: "
       + ("refused on product_variants_matrix_uq" if "product_variants_matrix_uq" in err else (err[:60] or "committed")),
       "PASS — exactly one commits; the index refuses the other, and it BLOCKS rather than racing" if ok else "**FINDING**")

# ── RACE B ──────────────────────────────────────────────────────────────────
product(PB,'RACE-B')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
d1,_=s1.send(f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PB}' AND axis_code='color';")
i2,b2=s2.send(V(PB,'c1000000-0000-0000-0000-00000000000b','{"size":"m","color":"blue"}'))
cm1,_=s1.send("COMMIT;"); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
_,orphan,_=admin("""SELECT count(*) FROM product_variants v
 WHERE v.business_id='%s' AND v.product_id='%s' AND NOT v.is_base AND v.attributes <> '{}'::jsonb
   AND EXISTS (SELECT 1 FROM jsonb_each(v.attributes) e
                WHERE NOT EXISTS (SELECT 1 FROM product_matrix_axes ma
                                   WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id
                                     AND ma.axis_code=e.key));"""%(A,PB))
record("B  axis removed vs variant inserted",
       "DELETE the 'color' axis of this product, then COMMIT",
       "INSERT a variant naming 'color', concurrently",
       f"T2 blocked: {b2}. T2: {(' '.join(i2+cm2)[:50] or 'committed')}. Variants naming an unregistered axis after both commit: {orphan}",
       "PASS — the closure invariant holds after both commit" if orphan=="0" else "**FINDING — the committed state violates the closure invariant**")

# ── RACE B2 — THE REVERSE ARRIVAL ORDER ─────────────────────────────────────
# Phase 4's TL-P4-COORD-R62 (measured there, PG18.4): a BEFORE ROW DELETE
# trigger cannot take a lock before the row being deleted, because the
# executor produces OLD through GetTupleForTrigger, which LOCKS that tuple
# before the trigger body is called. So `product_matrix_axes_10_axis_in_use`
# is a REFUSAL guard and never a lock-order device, and the ordering in race
# B comes from the INSERT side's `FOR KEY SHARE` meeting that executor lock.
#
# Which exposes a gap in race B: it only ran DELETE-first. The reverse order
# is the one where the trigger body matters — the deleter waits on the
# inserter's key-share lock, and then the guard must SEE the now-committed
# variant. R62's mechanism is exactly why it does (the lock is taken before
# the body runs), and one arrival order is half a proof; Phase 9's deadlock
# test runs both orders for the same reason.
product(PD,'RACE-B2')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
i1,_=s1.send(V(PD,'c1000000-0000-0000-0000-0000000000b2','{"size":"l","color":"green"}'))
d2,b2d=s2.send(f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PD}' AND axis_code='color';")
cm1,_=s1.send("COMMIT;")
d2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
_,axes,_=admin(f"SELECT count(*) FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PD}' AND axis_code='color';")
_,vars_,_=admin(f"SELECT count(*) FROM product_variants WHERE business_id='{A}' AND product_id='{PD}' AND NOT is_base AND attributes ? 'color';")
derr=" ".join(d2+d2b+cm2)
# The committed state must be closed: either the axis survives with its
# variant, or neither exists. A variant naming a deleted axis is the failure.
ok_b2 = (axes=="1" and vars_=="1")
record("B2 variant inserted vs axis removed (reverse order)",
       "INSERT a variant naming 'color', then COMMIT",
       "DELETE the 'color' axis, concurrently",
       f"T2 blocked: {b2d}. T2: {('refused on catalog.matrix_axis_in_use' if 'matrix_axis_in_use' in derr else (derr[:50] or 'committed'))}. Axis rows after both: {axes}; variants naming it: {vars_}",
       "PASS — the deleter waits on the inserter's key-share lock and the guard then SEES the committed variant (R62's mechanism: the executor locks OLD before the trigger body)" if ok_b2 else "**FINDING — the closure invariant depends on arrival order**")

# ── RACE C ──────────────────────────────────────────────────────────────────
product(PC,'RACE-C')
VC='c1000000-0000-0000-0000-00000000000c'
admin(V(PC,VC,'{"size":"s","color":"red"}'))
admin(f"INSERT INTO branches (business_id,id,name) VALUES ('{A}','{PC}','BR-C') ON CONFLICT DO NOTHING;")
admin(f"INSERT INTO warehouses (business_id,id,branch_id,name) VALUES ('{A}','{PC}','{PC}','WH-C');")
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
u1,_=s1.send(f"UPDATE product_variants SET attributes='{{\"size\":\"m\",\"color\":\"red\"}}'::jsonb WHERE business_id='{A}' AND id='{VC}';")
s2.send("SET ROLE daftar_inventory_internal;")
i2,b2=s2.send(f"INSERT INTO stock_levels (tenant_id,business_id,warehouse_id,variant_id,on_hand,valuation_base_minor,last_stock_seq) VALUES ('{TA}','{A}','{PC}','{VC}',1,0,0);")
cm1,_=s1.send("COMMIT;")
i2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
_,final,_=admin(f"""SELECT v.attributes::text || ' | stock rows: ' ||
   (SELECT count(*) FROM stock_levels sl WHERE sl.business_id=v.business_id AND sl.variant_id=v.id)::text
   FROM product_variants v WHERE v.business_id='{A}' AND v.id='{VC}';""")
assert final, "race C setup produced no row — refusing to report it"
bypassed = '"size": "m"' in final and final.endswith("stock rows: 1")
record("C  attributes changed vs first stock movement",
       "UPDATE attributes while no stock exists yet, then COMMIT",
       "INSERT the variant's FIRST stock_levels row, concurrently",
       f"T1: {(' '.join(u1+cm1)[:40] or 'committed')}. T2 blocked: {b2}. T2: {(' '.join(i2+i2b+cm2)[:40] or 'committed')}. Final: {final}",
       "**FINDING — the identity lock is bypassed by interleaving**" if bypassed else "PASS — the interleaving does not produce a changed-attributes-with-stock row")

w=max(len(r[0]) for r in rows)
print("## RESULT MATRIX — four races, real backends, no sleep()\n")
print(f"| {'race':<{w}} | T1 | T2 | observed | verdict |")
print(f"|{'-'*(w+2)}|---|---|---|---|")
for r in rows: print(f"| {r[0]:<{w}} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |")
findings=[r for r in rows if "FINDING" in r[4]]
print(f"\n{len(rows)} races run; {len(findings)} finding(s).")
for r in findings: print("  FINDING:", r[0], "->", r[3])
sys.exit(0)
