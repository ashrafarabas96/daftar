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
import subprocess, sys, threading, queue, time, random

import os
# The cluster is named by the environment so the harness can create its own
# on-target cluster and every script agrees on which one ran (finding P2-09).
SOCK=os.environ.get("P11_SOCK","/var/tmp/p11u/run"); PORT=os.environ.get("P11_PORT","55512"); DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
A='aaaaaaaa-0000-0000-0000-00000000000a'
TA='11111111-1111-1111-1111-111111111111'

# ── A PER-RUN NAMESPACE ───────────────────────────────────────────────────
# The docstring above explains why this file is append-only WITHIN one
# database: `stock_levels_retain()` refuses to delete a stock key at all, so
# a clean slate is not available and a race that deletes its way back to one
# measures something else. The second independent challenger then measured
# the price of that design on the sibling file: `proofs.py` was not
# idempotent, and a re-run failed seven cases with no mutation at all.
# Append-only and re-runnable are not in conflict — they only need the run
# to own its own names. So every product, variant, branch, warehouse, SKU
# and value code below carries a tag drawn once per run: a second run adds a
# second generation beside the first and measures its own, and the setup
# assertions keep their teeth instead of failing on a duplicate key. The tag
# can be pinned (P11_RUN_TAG) when a run has to be re-read afterwards.
RUN=os.environ.get("P11_RUN_TAG") or "%06x" % random.randrange(16**6)
def U(tag, n): return f"{tag}{RUN}-0000-0000-0000-{n:012d}"
PR=U('4a',1)   # race A product
PB=U('4b',1)   # race B product
PC=U('4c',1)   # race C product
PD=U('4d',1)   # race B2 product (the reverse arrival order)

LIVE=[]
_OV=[0]

def _note_overlap():
    """How many of this file's own backends are inside a transaction right
    now, read from a THIRD connection. Called after every statement, and the
    MAXIMUM over a race is what `record` then requires to be 2.

    `xact_start IS NOT NULL` is the test rather than `backend_xid`, because a
    transaction that has already been refused stays open-and-aborted and must
    still count as having overlapped -- the races that expect a refusal are
    exactly the ones whose overlap would otherwise read as absent."""
    if len(LIVE) < 2: return
    pids=",".join(str(int(x.pid)) for x in LIVE if str(x.pid).strip().isdigit())
    if not pids: return
    rc,out,_=admin(f"SELECT count(*) FROM pg_stat_activity WHERE pid IN ({pids}) AND xact_start IS NOT NULL;",
                   must_succeed=False)
    try: _OV[0]=max(_OV[0], int(out.splitlines()[-1]))
    except Exception: pass

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
        # The backend's own pid, so OVERLAP is measured rather than assumed.
        # See the comment above `record` -- this file was NOT the one the
        # fourth round found the verdict defect in, and it is instrumented
        # anyway, because three of its own verdicts ("the forbidden state is
        # absent after both commit") are satisfied by nothing happening too.
        self.pid=(self.send("SELECT pg_backend_pid();")[0] or ["0"])[-1]
        LIVE.append(self)
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
            if sent in line:
                _note_overlap(); return out, False
            if line.strip(): out.append(line.strip())
    def close(self):
        if self in LIVE: LIVE.remove(self)
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
def record(*r):
    """Every row passes through here, so the OVERLAP requirement is stated
    once for the whole file.

    Finding P2-01 of the fourth independent challenge was measured on Pack
    B's `races_b.py`: its verdict was `key == cache`, which is satisfied by
    an untouched database, so a planted unrelated refusal produced a printed
    PASS for a race in which nothing happened. This file's verdicts are
    per-race and most of them assert a specific observed outcome (exactly one
    commits, the loser BLOCKED, the guard refused by name), which that
    planting would fail. Three do not: "the forbidden state is absent after
    both commit" is true of a database neither transaction touched. Rather
    than reason about which three, the requirement is applied to all of them:
    a race whose two backends were never inside a transaction at the same
    time did not happen, and its verdict is replaced by a FINDING whatever it
    says."""
    ov=_OV[0]; _OV[0]=0
    r=list(r)
    r[3]=f"{r[3]} | backends in a transaction together: {ov}/2"
    if ov<2:
        r[4]="**FINDING — the two sessions never overlapped, so this race measured nothing** (was: "+str(r[4])[:70]+")"
    rows.append(tuple(r))

# ── RACE A ──────────────────────────────────────────────────────────────────
product(PR,f'RACE-A-{RUN}')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
s1.send(V(PR,U('4a',2),'{"size":"s","color":"red"}'))
o2,blocked=s2.send(V(PR,U('4a',3),'{"size":"s","color":"red"}'))
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
product(PB,f'RACE-B-{RUN}')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
d1,_=s1.send(f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PB}' AND axis_code='color';")
i2,b2=s2.send(V(PB,U('4b',2),'{"size":"m","color":"blue"}'))
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
# B comes from the INSERT side's row SHARE lock meeting that executor lock.
#
# Which exposes a gap in race B: it only ran DELETE-first. The reverse order
# is the one where the trigger body matters — the deleter waits on the
# inserter's share lock, and then the guard must SEE the now-committed
# variant. R62's mechanism is exactly why it does (the lock is taken before
# the body runs), and one arrival order is half a proof; Phase 9's deadlock
# test runs both orders for the same reason.
product(PD,f'RACE-B2-{RUN}')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
i1,_=s1.send(V(PD,U('4d',2),'{"size":"l","color":"blue"}'))
# T1's own arm is setup for this race: if it is refused, nothing holds the
# share lock and the race measures nothing. The first run of this race
# used 'green', which `product_attribute_values` does not register, so T1
# was refused `catalog.variant_axis_value_unregistered`, never took the
# lock, and the harness duly reported a FINDING that was its own. The
# finding was real information about the harness, and it was caught because
# the assertion reads the COMMITTED STATE rather than an error string.
if any("ERROR" in line for line in i1):
    print("HARNESS SETUP FAILED — race B2's T1 arm was refused, so nothing held the lock:")
    print("  ", " ".join(i1)[:200]); sys.exit(2)
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
       "PASS — the deleter waits on the inserter's FOR SHARE row lock and the guard then SEES the committed variant (R62's mechanism: the executor locks OLD before the trigger body)" if ok_b2 else "**FINDING — the closure invariant depends on arrival order**")

# ── RACE C ──────────────────────────────────────────────────────────────────
product(PC,f'RACE-C-{RUN}')
VC=U('4c',2)
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

# ── RACES D, E, F — the VALUE registry, which had no guard at all ──────────
# The independent challenge at 1a8ba15 (findings P1-03, P1-05): races A..B2
# all attack the AXIS registry. The VALUE registry had no guard on any
# removal path, and the lock the concurrency law credited was `FOR KEY SHARE`,
# which does not conflict with the non-key UPDATE that archives a value row.
# So the same two arrival orders are run here against the value registry,
# each on its own value code so the count belongs to its own race.
PE=U('4e',1)
PF=U('4f',1)
PG_=U('40',1)

RD1=f"rd1_{RUN}"; RD2=f"rd2_{RUN}"; RD3=f"rd3_{RUN}"
# `product_attribute_values_sort_uq` is UNIQUE (business, axis, sort_order),
# so the sort order is part of the per-run namespace too: a fixed 11/12/13
# collides on a second run exactly as a fixed value code does.
SORT=1000 + int(RUN,16) % 100000

def value(code, sort):
    admin(f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','color','{code}',{sort});")

def orphans(pid):
    """Committed non-base variants of this product naming a value code that is
    not an ACTIVE registered value. The assertion reads the committed state,
    never an error string (the lesson race B2 paid for)."""
    _,n,_=admin("""SELECT count(*) FROM product_variants v
     WHERE v.business_id='%s' AND v.product_id='%s' AND NOT v.is_base AND v.attributes <> '{}'::jsonb
       AND EXISTS (SELECT 1 FROM jsonb_each(v.attributes) e
                    WHERE NOT EXISTS (SELECT 1 FROM product_attribute_values av
                                       WHERE av.business_id=v.business_id AND av.axis_code=e.key
                                         AND av.value_code=e.value #>> '{}' AND av.status='active'));"""%(A,pid))
    return n

# ── RACE D — a value ARCHIVED while a variant naming it is inserted ────────
product(PE,f'RACE-D-{RUN}'); value(RD1,SORT)
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
i1,_=s1.send(V(PE,U('4e',2),'{"size":"s","color":"'+RD1+'"}'))
if any("ERROR" in l for l in i1):
    print("HARNESS SETUP FAILED — race D's T1 arm was refused, so nothing held the lock:"); print("  "," ".join(i1)[:200]); sys.exit(2)
u2,bd=s2.send(f"UPDATE product_attribute_values SET status='archived' WHERE business_id='{A}' AND axis_code='color' AND value_code='{RD1}';")
s1.send("COMMIT;")
u2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
derr=" ".join(u2+u2b+cm2); od=orphans(PE)
record("D  value archived vs variant inserted",
       "INSERT a variant naming the value row of this run, then COMMIT",
       "UPDATE that value row to status='archived', concurrently",
       f"T2 blocked: {bd}. T2: {('refused on catalog.attribute_value_in_use' if 'attribute_value_in_use' in derr else (derr[:50] or 'committed'))}. Variants naming a non-active value after both: {od}",
       "PASS — FOR SHARE makes the non-key UPDATE wait, and the new in-use guard then refuses it" if (bd and od=="0") else "**FINDING — a committed variant names an archived value**")

# ── RACE E — a value DELETED while a variant naming it is inserted ─────────
product(PF,f'RACE-E-{RUN}'); value(RD2,SORT+1)
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
i1,_=s1.send(V(PF,U('4f',2),'{"size":"s","color":"'+RD2+'"}'))
if any("ERROR" in l for l in i1):
    print("HARNESS SETUP FAILED — race E's T1 arm was refused, so nothing held the lock:"); print("  "," ".join(i1)[:200]); sys.exit(2)
d2,be=s2.send(f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='{RD2}';")
s1.send("COMMIT;")
d2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
eerr=" ".join(d2+d2b+cm2); oe=orphans(PF)
record("E  value deleted vs variant inserted",
       "INSERT a variant naming the value row of this run, then COMMIT",
       "DELETE that value row, concurrently",
       f"T2 blocked: {be}. T2: {('refused on catalog.attribute_value_in_use' if 'attribute_value_in_use' in eerr else (eerr[:50] or 'committed'))}. Variants naming a value that no longer exists: {oe}",
       "PASS — the deleter waits, then the guard sees the committed variant and refuses" if (be and oe=="0") else "**FINDING — an unguarded value delete orphans a committed variant**")

# ── RACE F — the REVERSE order of race E ───────────────────────────────────
# Delete-first was already green at 1a8ba15 for the wrong reason: nothing
# refused the deleter, and the INSERTER was refused afterwards by its own
# registry read. It is run here so the pair is complete and so the guard
# cannot be credited for what the validator does.
product(PG_,f'RACE-F-{RUN}'); value(RD3,SORT+2)
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
d1,_=s1.send(f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='{RD3}';")
if any("ERROR" in l for l in d1):
    print("HARNESS SETUP FAILED — race F's T1 delete was refused although no variant names the value:"); print("  "," ".join(d1)[:200]); sys.exit(2)
i2,bf=s2.send(V(PG_,U('40',2),'{"size":"s","color":"'+RD3+'"}'))
s1.send("COMMIT;")
i2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
ferr=" ".join(i2+i2b+cm2); of=orphans(PG_)
record("F  value deleted vs variant inserted (reverse order)",
       "DELETE this run's value row, then COMMIT",
       "INSERT a variant naming this run's value row, concurrently",
       f"T2 blocked: {bf}. T2: {('refused on catalog.variant_axis_value_unregistered' if 'value_unregistered' in ferr else (ferr[:50] or 'committed'))}. Orphan variants: {of}",
       "PASS — the inserter waits on the deleted row and is then refused by its own registry read" if of=="0" else "**FINDING — the closure invariant depends on arrival order**")

# ── RACES G and H — the ADD direction, which P1-N01 found unguarded ───────
# The second challenge round found that an axis could be ADDED to a matrix
# that already had variants, leaving a committed variant no cell can address.
# The fix is product_matrix_axes_30_set_frozen, and it reads product_variants
# — so it is exactly the shape every race in this file attacks: a guard that
# concludes from a read. Row locks cannot order these two writes (the
# validator can only lock matrix rows that already exist; the freeze guard
# cannot see an uncommitted variant), so both paths take a transaction
# advisory lock on (business_id, product_id): SHARED on the variant side,
# EXCLUSIVE on the matrix side. Both arrival orders are run, because one
# order is half a proof — the lesson race B2 was added for.
PGG=U('41',1)
PHH=U('42',1)
admin(f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','material',{SORT+3}) ON CONFLICT DO NOTHING;")
admin(f"UPDATE product_attribute_axes SET status='active' WHERE business_id='{A}' AND axis_code='material';")

def nonconforming(pid):
    """Committed non-base variants of this product whose attributes are not
    EXACTLY its product's registered axis set — the challenger's own
    measurement of P1-N01, read from the committed state."""
    _,n,_=admin("""SELECT count(*) FROM product_variants v
     WHERE v.business_id='%s' AND v.product_id='%s' AND NOT v.is_base
       AND ( (SELECT count(*) FROM product_matrix_axes ma
               WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id)
             <> (SELECT count(*) FROM jsonb_each(v.attributes))
          OR EXISTS (SELECT 1 FROM jsonb_each(v.attributes) e
                      WHERE NOT EXISTS (SELECT 1 FROM product_matrix_axes ma
                                         WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id
                                           AND ma.axis_code=e.key)) );"""%(A,pid))
    return n

# ── RACE G — the product's FIRST variant vs a third axis ──────────────────
product(PGG,f'RACE-G-{RUN}')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
i1,_=s1.send(V(PGG,U('41',2),'{"size":"s","color":"red"}'))
if any("ERROR" in l for l in i1):
    print("HARNESS SETUP FAILED — race G's T1 arm was refused, so nothing held the lock:"); print("  "," ".join(i1)[:200]); sys.exit(2)
a2,bg=s2.send(f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PGG}','material',3);")
s1.send("COMMIT;")
a2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
gerr=" ".join(a2+a2b+cm2); ng=nonconforming(PGG)
_,gax,_=admin(f"SELECT count(*) FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PGG}';")
record("G  first variant inserted vs a third axis added",
       "INSERT the product's first variant {size:s,color:red}, then COMMIT",
       "INSERT a third axis into the same matrix, concurrently",
       f"T2 blocked: {bg}. T2: {('refused on catalog.matrix_axis_set_frozen' if 'matrix_axis_set_frozen' in gerr else (gerr[:50] or 'committed'))}. Axes after both: {gax}; variants not naming exactly the registered set: {ng}",
       "PASS — the axis write waits on the variant's shared advisory lock and the freeze guard then SEES the committed variant" if (ng=="0" and gax=="2") else "**FINDING — an axis was added under a committed variant**")

# ── RACE H — THE REVERSE ARRIVAL ORDER ───────────────────────────────────
# Here the freeze guard is NOT the defence: when T1 adds the axis the
# product has no variants at all, so the add is lawful and commits. The
# invariant has to be held by the VARIANT side instead — T2's completeness
# count must see the third axis. In READ COMMITTED a plpgsql trigger's
# queries take a fresh snapshot per statement, so once T2 stops waiting on
# the advisory lock its count reads 3 registered against 2 supplied. That is
# the claim; the verdict below is what was measured.
product(PHH,f'RACE-H-{RUN}')
s1,s2=Session("1"),Session("2")
s1.send("BEGIN;"); s2.send("BEGIN;")
a1,_=s1.send(f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PHH}','material',3);")
if any("ERROR" in l for l in a1):
    print("HARNESS SETUP FAILED — race H's T1 axis insert was refused although the product has no variants:"); print("  "," ".join(a1)[:200]); sys.exit(2)
i2,bh=s2.send(V(PHH,U('42',2),'{"size":"s","color":"red"}'))
s1.send("COMMIT;")
i2b,_=s2.send(""); cm2,_=s2.send("COMMIT;")
s1.close(); s2.close()
herr=" ".join(i2+i2b+cm2); nh=nonconforming(PHH)
_,hax,_=admin(f"SELECT count(*) FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PHH}';")
_,hvar,_=admin(f"SELECT count(*) FROM product_variants WHERE business_id='{A}' AND product_id='{PHH}' AND NOT is_base;")
record("H  a third axis added vs the first variant (reverse order)",
       "INSERT a third axis while the product has no variants, then COMMIT",
       "INSERT a 2-axis variant, concurrently",
       f"T2 blocked: {bh}. T2: {('refused on catalog.variant_axis_set_incomplete' if 'variant_axis_set_incomplete' in herr else (herr[:50] or 'committed'))}. Axes after both: {hax}; non-base variants: {hvar}; not naming exactly the registered set: {nh}",
       "PASS — the variant write waits, then its completeness count sees the third axis and refuses the partial combination" if nh=="0" else "**FINDING — the closure invariant depends on arrival order**")

w=max(len(r[0]) for r in rows)
print(f"## RESULT MATRIX — {len(rows)} races, real backends, no sleep()\n")
print(f"| {'race':<{w}} | T1 | T2 | observed | verdict |")
print(f"|{'-'*(w+2)}|---|---|---|---|")
for r in rows: print(f"| {r[0]:<{w}} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |")
findings=[r for r in rows if "FINDING" in r[4]]
print(f"\n{len(rows)} races run; {len(findings)} finding(s).")
for r in findings: print("  FINDING:", r[0], "->", r[3])
# EXIT CODE, and a defect of this harness found by re-reading it for the
# challenge round: it used to `sys.exit(0)` unconditionally, so a race that
# reported a FINDING in its own matrix still returned success, and
# `EXIT_RACES` would have been 0 over a failing run. No race had failed, so
# nothing exposed it — which is exactly the class of defect V3 §9 asks for
# exit codes to prevent, in the harness that prints them.
sys.exit(1 if findings else 0)
