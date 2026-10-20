"""Phase 11 PACK B (lot / expiry) — the executed proof.

Same machinery as `proofs.py`, same laws document. What is proved here is the
OVERLAY's structure and its conservation triggers; the writer change (patch
request 3.6) is not in this round, so C-LOT-01's integration with
`inventory_apply_stock_movements` stays `WAITING_FOR_INTEGRATED_SURFACE`.
The triggers themselves are exercised by writing movements as the internal
principal, which is the only principal holding INSERT on `stock_movements` —
so this is the authority's own privilege, not a borrowed one, and it is still
not the production path.
"""
import sys

if not sys.flags.isolated:
    sys.stderr.write(
        "PROOFS-B-NOT-ISOLATED: this program must run under `python3 -I`. Without it the\n"
        "interpreter puts the script's own directory on `sys.path`, and that directory\n"
        "is the harness -- a planted `subprocess.py` or `hashlib.py` beside it would be\n"
        "imported by the program whose output the figure gate now treats as the only\n"
        "legitimate source of a figure. The driver always passes `-I`; a reviewer\n"
        "running this file by hand must too. Refusing rather than re-executing, because\n"
        "a re-exec reads the target a second time. (The coordinator's `C27-S2`: two of\n"
        "the pack's eight instruments refused without `-I` and six did not.)\n"
    )
    raise SystemExit(5)

import subprocess, sys
import os
import re
# The cluster is named by the environment so the harness can create its own
# on-target cluster and every script agrees on which one ran (finding P2-09).
SOCK=os.environ.get("P11_SOCK","/var/tmp/p11u/run"); PORT=os.environ.get("P11_PORT","55512"); DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
A='aaaaaaaa-0000-0000-0000-00000000000a'; B='bbbbbbbb-0000-0000-0000-00000000000b'
TA='11111111-1111-1111-1111-111111111111'; TB='22222222-2222-2222-2222-222222222222'
WH='7c000000-0000-0000-0000-00000000007c'
WH2='7c000000-0000-0000-0000-0000000000c2'   # the second key, which never gets a cache row
P_LOT='7d000000-0000-0000-0000-00000000007d'; P_NOLOT='7e000000-0000-0000-0000-00000000007e'
ACTOR='99999999-0000-0000-0000-000000000099'

CTX=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';\n"

def run(sql, role="postgres", pre=CTX):
    cmd=[PSQL,"-h",SOCK,"-p",PORT,"-U",role,"-d",DB,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-f","-"]
    r=subprocess.run(["su","postgres","-s","/bin/bash","-c"," ".join(cmd)], input=pre+sql, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


# ── THE FIGURE SINK, round 27's blocker ───────────────────────────────────
# `R27-F1`, measured end to end by both challengers of round 27: round 26 made
# a figure legitimate because A RUN PRINTED it, and printing is as cheap as
# commenting. One `RAISE NOTICE 'spectre_notice=7722'` in a data fixture, and
# one `echo` in the driver, each carried a fabricated figure through the whole
# authoritative pack to `EXIT_SCRIPT 0`. The printed string was a LITERAL: it
# was computed from nothing, and no assertion anywhere would have failed if the
# number had been different.
#
# So a figure is not legitimate because it was printed. It is legitimate when a
# CASE REQUIRED it: `case(..., expect, kind="value")` fails, and this suite
# exits non-zero, if the measured value does not contain `expect`. That is the
# binding, and this is where it is recorded -- one row per expectation line of
# every value case that PASSED, written to a file the harness creates for this
# run and hands to the figure gate. A `RAISE NOTICE` cannot write a row here;
# an `echo` cannot; a comment cannot; and a case whose number differed would
# not be in the file at all, because it would not have passed.
#
# The row carries the CASE that required it, which is round 27's second
# finding: `axes=3` is a figure this run really produces, for Pack A's grid,
# and a document asserted it of Pack B's, where the same run produces
# `axes=2`. A figure bound to its case can be attributed, so the gate can red
# a true string asserted of the wrong thing.
FIGURE_SINK = os.environ.get("P11_FIGURE_SINK") or os.environ.get("P11_RUN_CAPTURE")
FIGURE_SUITE = "PACK_B"
CASE_ID = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$")


def _case_id(name):
    """The case's own identifier: its first token, when that is an id.

    A case named in prose pins nothing -- a document cannot reference it -- and
    that is reported rather than guessed at: the row carries
    `UNIDENTIFIED-CASE`, and the gate will not bind a figure to that.
    """
    head = name.split()[0] if name.split() else ""
    return head if CASE_ID.match(head) else "UNIDENTIFIED-CASE"


def _sink(name, expect):
    """One tab-separated row per expectation LINE of a passing value case."""
    if not FIGURE_SINK:
        return
    try:
        with open(FIGURE_SINK, "a", encoding="utf-8") as fh:
            for line in str(expect).splitlines():
                line = line.strip()
                if line:
                    fh.write("FIGURE\t" + FIGURE_SUITE + "\t" + _case_id(name)
                             + "\t" + line + "\n")
    except OSError as exc:
        # Loud, never silent: a gate reading a sink this suite could not write
        # would report "no case asserted it" as if no case had.
        print("FIGURE-SINK-UNWRITABLE: " + str(FIGURE_SINK) + " (" + str(exc) + ")")
        raise

cases=[]
def case(name, sql, expect, role="postgres", pre=CTX, kind="refusal"):
    rc,out,err=run(sql,role,pre)
    if kind=="refusal":
        ok = rc!=0 and expect in err
        detail=(err.splitlines()[0] if err else "no error") if not ok else expect
    else:
        ok = rc==0 and expect in out
        detail=(out or err.splitlines()[0] if err else out) if not ok else expect
    if kind == "value" and ok:
        _sink(name, expect)
    cases.append((name,"RED (refused as required)" if (ok and kind=="refusal") else ("GREEN" if ok else "**PROOF FAILED**"),detail))
    return ok

def vid_of(product):
    rc,out,err=run(f"SELECT id FROM product_variants WHERE business_id='{A}' AND product_id='{product}' AND is_base;")
    assert rc==0 and out, f"world not built: {err or out}"
    return out.splitlines()[0]

V_LOT=vid_of(P_LOT); V_NOLOT=vid_of(P_NOLOT)

# The world's stock keys and lots are created as the internal principal, the
# only one with INSERT on these relations.
INT="SET ROLE daftar_inventory_internal;\n"
def lots_setup():
    rc,out,err=run(INT+f"""
      INSERT INTO stock_levels (tenant_id,business_id,warehouse_id,variant_id,on_hand,valuation_base_minor,last_stock_seq)
        VALUES ('{TA}','{A}','{WH}','{V_LOT}',0,0,0),('{TA}','{A}','{WH}','{V_NOLOT}',0,0,0),
               ('{TA}','{A}','{WH2}','{V_LOT}',0,0,0)
        ON CONFLICT DO NOTHING;   -- idempotence: see the note in proofs.py
      INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,expiry_date,received_seq)
        VALUES ('{TA}','{A}','a1000000-0000-0000-0000-0000000000a1','{V_LOT}',catalog_identifier_norm('sku','L-A'),'L-A','2027-01-31',1),
               ('{TA}','{A}','a2000000-0000-0000-0000-0000000000a2','{V_LOT}',catalog_identifier_norm('sku','L-B'),'L-B','2026-12-31',2),
               -- A third lot that NO movement ever names, so the P3 case about
               -- a correctable receipt typo has a subject that exists in the
               -- same shape on every run. It is in the setup rather than in
               -- that case because a case that creates a row another section
               -- counts makes the other section order-dependent.
               ('{TA}','{A}','a8000000-0000-0000-0000-0000000000a8','{V_LOT}',catalog_identifier_norm('sku','L-G'),'L-G','2027-03-31',8)
        ON CONFLICT DO NOTHING;
    """)
    if rc!=0:
        print("HARNESS SETUP FAILED — refusing to report proofs it did not run:"); print(" ", err.splitlines()[0] if err else out); sys.exit(2)
lots_setup()

LA='a1000000-0000-0000-0000-0000000000a1'; LB='a2000000-0000-0000-0000-0000000000a2'
M=lambda n: f"b{n}000000-0000-0000-0000-0000000000b{n}"
# Two-digit document ids for the challenge-answer section, so the first group
# stays eight hex characters (M() was written for one digit).
D=lambda n: f"b{n}00000-0000-0000-0000-0000000000{n}"

# ── The movement comes from the OFFICIAL COMMAND, not from this file ───────
# The first version of these cases wrote `stock_source_bindings` and
# `stock_movements` by hand as the internal principal, and eight cases failed
# on `inventory.stock_source_line_missing`. The refusal was CORRECT: an
# adjustment binding requires a row in
# `stock_source_bridge_inventory_adjustment`, whose one writer
# (`inventory_bridge_source_lines`, 0062) refuses unless this transaction's
# entry routine consumed an inventory assertion for an operation that owns
# that source type. There is no honest way to satisfy that by hand.
#
# So each case now calls `inventory_adjust_stock` through `fixture_adjust`
# (world_b.sql), which mints the assertion the command demands and calls it
# as `daftar_app`. The overlay is therefore proved over a movement written by
# the REAL writer, with its real binding and its real bridge row — which is
# also what PART 7.8 asks of a specialized unit: consume the official
# services and create no second inventory.
#
# The whole arrangement runs inside ONE transaction per case, in a plpgsql
# block, because the conservation triggers are DEFERRABLE INITIALLY DEFERRED
# and fire at COMMIT. The block does the command and the overlay inserts; the
# verdict comes from the COMMIT.
def txn(body, mid_var="m"):
    """A transaction whose plpgsql block holds the command and the overlay."""
    return "BEGIN;\nDO $pf$ DECLARE " + mid_var + " UUID; BEGIN\n" + body + "\nEND $pf$;\nCOMMIT;\n"

def adjust(qty, variant, doc, var="m", cost=0):
    return f"  {var} := fixture_adjust('{doc}','{WH}','{variant}',{qty},{cost});\n"

def ov(lot, qty, variant=None, var="m", idem=False):
    # `idem=True` only where the case's movement COMMITS: the official
    # command replays on its own document, so a second run of this file gets
    # the SAME movement id back and the overlay row is already there. The
    # cases whose transaction is meant to abort keep the plain insert, so a
    # duplicate there would still be reported rather than swallowed.
    return (f"  INSERT INTO stock_lot_movements (tenant_id,business_id,stock_movement_id,warehouse_id,variant_id,lot_id,qty_delta)"
            f" VALUES ('{TA}','{A}',{var},'{WH}','{variant or V_LOT}','{lot}',{qty})"
            + (" ON CONFLICT DO NOTHING" if idem else "") + ";\n")

# ── 1. the overlay's own structure ─────────────────────────────────────────
case("a lot code must be the catalogue's canonical form, not a second normalization",
     INT+f"INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,received_seq)"
         f" VALUES ('{TA}','{A}','a3000000-0000-0000-0000-0000000000a3','{V_LOT}','not-canonical','L-C',3);",
     "stock_lots_code_canonical_ck")
case("the same lot code twice for one variant",
     INT+f"INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,received_seq)"
         f" VALUES ('{TA}','{A}','a4000000-0000-0000-0000-0000000000a4','{V_LOT}',catalog_identifier_norm('sku','L-A'),'L-A',4);",
     "stock_lots_code_uq")
case("expiry before production",
     INT+f"INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,produced_on,expiry_date,received_seq)"
         f" VALUES ('{TA}','{A}','a5000000-0000-0000-0000-0000000000a5','{V_LOT}',catalog_identifier_norm('sku','L-D'),'L-D','2026-06-01','2026-05-01',5);",
     "stock_lots_dates_ck")
case("a status outside active/blocked/closed (a quarantine is a status, not a value change)",
     INT+f"INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,received_seq,status)"
         f" VALUES ('{TA}','{A}','a6000000-0000-0000-0000-0000000000a6','{V_LOT}',catalog_identifier_norm('sku','L-E'),'L-E',6,'destroyed');",
     "stock_lots_status_ck")

# ── 2. the overlay cannot name the wrong thing ─────────────────────────────
case("an overlay row naming a lot of ANOTHER variant",
     txn(adjust(5,V_NOLOT,M(1))+ov(LA,5,V_NOLOT)),
     "stock_lot_movements_lot_fk")
case("an overlay row naming a movement of another stock key",
     txn(adjust(5,V_LOT,M(2))+ov(LA,5,V_NOLOT)),
     "stock_lot_movements_movement_fk")
case("a zero overlay delta", txn(adjust(5,V_LOT,M(3))+ov(LA,0)),
     "stock_lot_movements_qty_ck")

# ── 3. conservation, at COMMIT (C-LOT-01) ─────────────────────────────────
case("PB10-01 the happy path: a lot-tracked movement whose allocation sums exactly",
     txn(adjust(10,V_LOT,M(4))+ov(LA,6,idem=True)+ov(LB,4,idem=True))
     +f"SELECT count(*)::text FROM stock_lot_movements lm JOIN stock_movements m ON m.business_id=lm.business_id AND m.id=lm.stock_movement_id"
      f" WHERE lm.business_id='{A}' AND m.source_id='{M(4)}';",
     "2", kind="value")
case("the allocation sums to less than the movement (C-LOT-01)",
     txn(adjust(10,V_LOT,M(5))+ov(LA,6)),
     "inventory.lot_allocation_sum_mismatch")
case("a lot-tracked movement with NO allocation at all",
     txn(adjust(7,V_LOT,M(6))),
     "inventory.lot_allocation_missing")
case("an allocation on a variant that is NOT lot-tracked",
     txn(adjust(5,V_NOLOT,M(7))+ov(LA,5,V_NOLOT)),
     "stock_lot_movements_lot_fk")
case("an allocation whose SIGN disagrees with the movement",
     txn(adjust(10,V_LOT,M(8))+ov(LA,12)+ov(LB,-2)),
     "inventory.lot_allocation_sign_invalid")

# The deferred trigger must hold when the transaction asks for it IMMEDIATELY.
# A law that only holds while deferred is not a law — the shape of Phase 4's
# round-13 defect.
case("SET CONSTRAINTS ALL IMMEDIATE does not switch the conservation law off",
     "BEGIN;\nDO $pf$ DECLARE m UUID; BEGIN\n"+adjust(9,V_LOT,M(9))+ov(LA,3)+"END $pf$;\n"
     "SET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;",
     "inventory.lot_allocation_sum_mismatch")

# ── 4. append-only (the existing twin, not a second implementation) ───────
# Run as the MIGRATOR, the only principal holding UPDATE/DELETE here at all:
# as any runtime role the privilege refuses first, which proves the grant and
# not the law. So this asks the strongest principal in the database, and the
# answer is still no.
case("an overlay row cannot be updated, not even by the principal that owns the table",
     f"UPDATE stock_lot_movements SET qty_delta=1 WHERE business_id='{A}' AND lot_id='{LA}';",
     "inventory.ledger_immutable", role="daftar_migrator")
case("nor deleted", f"DELETE FROM stock_lot_movements WHERE business_id='{A}' AND lot_id='{LA}';",
     "inventory.ledger_immutable", role="daftar_migrator")

# ── 5. the per-lot cache folds to the key (C-LOT-03) ─────────────────────
# Both cache cases write EVERY lot row of the key, not only the one under
# test, so the sum they measure is theirs: the second of them commits, and a
# re-run of this file would otherwise find LB already at 4 and make the
# first case's 6-against-10 mismatch into a lawful 10-against-10. The law is
# about the SUM, so a case that does not state the whole sum is a case whose
# verdict depends on what ran before it.
case("the per-lot cache cannot disagree with the stock key's on-hand",
     INT+f"""BEGIN;
       UPDATE stock_levels SET on_hand=10 WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';
       INSERT INTO stock_lot_levels (tenant_id,business_id,warehouse_id,variant_id,lot_id,on_hand,last_movement_seq)
         VALUES ('{TA}','{A}','{WH}','{V_LOT}','{LA}',6,101),('{TA}','{A}','{WH}','{V_LOT}','{LB}',0,101)
         ON CONFLICT (business_id,warehouse_id,variant_id,lot_id) DO UPDATE
           SET on_hand=EXCLUDED.on_hand, last_movement_seq=EXCLUDED.last_movement_seq;
       COMMIT;""",
     "inventory.lot_level_conservation_violated")
case("PB10-02 and it commits when it does agree",
     INT+f"""BEGIN;
       UPDATE stock_levels SET on_hand=10 WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';
       INSERT INTO stock_lot_levels (tenant_id,business_id,warehouse_id,variant_id,lot_id,on_hand,last_movement_seq)
         VALUES ('{TA}','{A}','{WH}','{V_LOT}','{LA}',6,101),('{TA}','{A}','{WH}','{V_LOT}','{LB}',4,101)
         ON CONFLICT (business_id,warehouse_id,variant_id,lot_id) DO UPDATE
           SET on_hand=EXCLUDED.on_hand, last_movement_seq=EXCLUDED.last_movement_seq;
       COMMIT;
       SELECT sum(on_hand)::text FROM stock_lot_levels WHERE business_id='{A}' AND variant_id='{V_LOT}';""",
     "10", kind="value")
case("a negative per-lot on-hand", INT+f"UPDATE stock_lot_levels SET on_hand=-1 WHERE business_id='{A}' AND lot_id='{LA}';",
     "stock_lot_levels_on_hand_ck")

# ── 6. the fold, and its scope guard ─────────────────────────────────────
case("PB10-03 the fold reports the lot's own quantity from the movements, not the cache",
     f"SELECT on_hand::text FROM inventory_lot_fold('{A}','{WH}','{V_LOT}','{LA}');", "6", kind="value")
case("the fold refuses a key outside the transaction's business",
     f"SELECT * FROM inventory_lot_fold('{B}','{WH}','{V_LOT}','{LA}');", "inventory.scope_mismatch")

# ── 7. the authority the patch request never named ───────────────────────
case("daftar_app cannot switch lot tracking on (it is inventory configuration)",
     f"UPDATE products SET track_lot=true WHERE business_id='{A}' AND id='{P_NOLOT}';",
     "inventory.configuration_authority_required", role="daftar_app")
case("nor set it at insert time",
     f"INSERT INTO products (business_id,id,sku,status,base_price_minor,price_currency,track_lot)"
     f" VALUES ('{A}','7f000000-0000-0000-0000-00000000007f','X-LOT','active',0,'ILS',true);",
     "inventory.configuration_authority_required", role="daftar_app")
case("lot tracking cannot change once the product has stock history",
     INT+f"UPDATE products SET track_lot=false WHERE business_id='{A}' AND id='{P_LOT}';",
     "inventory.lot_tracking_history_locked")
case("a lot of something that holds no stock at all",
     f"SELECT fixture_force_lot_flag('7f000000-0000-0000-0000-00000000007f');",
     "products_lot_requires_tracking_ck")
case("the expiry policy admits exactly one value in this phase",
     INT+f"UPDATE products SET expiry_policy='allow_override' WHERE business_id='{A}' AND id='{P_LOT}';",
     "products_expiry_policy_ck")

# ── 8. tenant and business isolation, from the application role ──────────
case("as daftar_app in business B, business A's lots are invisible",
     f"SELECT count(*)::text FROM stock_lots;", "0", role="daftar_app",
     pre=f"SET app.tenant_id='{TB}'; SET app.business_id='{B}';\n", kind="value")
# Three: L-A, L-B and the untouched L-G of the setup above.
case("with business A's own context the same lots ARE visible",
     f"SELECT count(*)::text FROM stock_lots;", "3", role="daftar_app", kind="value")
case("business A's context with the WRONG tenant sees nothing",
     f"SELECT count(*)::text FROM stock_lots;", "0", role="daftar_app",
     pre=f"SET app.tenant_id='{TB}'; SET app.business_id='{A}';\n", kind="value")
case("daftar_app cannot write a lot at all (the overlay is the authority's)",
     f"INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,received_seq)"
     f" VALUES ('{TA}','{A}','a7000000-0000-0000-0000-0000000000a7','{V_LOT}',catalog_identifier_norm('sku','L-F'),'L-F',7);",
     "permission denied", role="daftar_app")

# ── 9. Option B, asserted from the catalogue rather than from the text ───
case("no monetary column exists on any overlay relation (L-P11-02)",
     "SELECT count(*)::text FROM information_schema.columns WHERE table_name IN "
     "('stock_lots','stock_lot_movements','stock_lot_levels') AND column_name ~ "
     "'(minor|price|cost|value|amount|currency|valuation)';", "0", kind="value")
case("the costing key is untouched: stock_levels still has no column below the variant",
     "SELECT count(*)::text FROM information_schema.columns WHERE table_name='stock_levels' AND column_name='lot_id';",
     "0", kind="value")

# ── 10. THE FIRST INDEPENDENT CHALLENGE OF PACK B, ANSWERED ──────────────
# Four findings and three notes, verdict REJECT, at b43871b. Each fix gets
# the red proof the report asks for, and the two P1 cases are the
# challenger's own attacks rather than restatements of them.

# P1-01. The cache-versus-key comparison existed only on the side that WRITES
# THE CACHE. The state below is exactly the challenger's: the two cache cases
# above leave LA=6, LB=4 and the key at 10, every law of the pack satisfied.
# One more lot-tracked movement through the OFFICIAL command, with its
# allocation and no cache write, moved the key to 12 against a cache summing
# to 10 and COMMITTED. It is now refused from the movement side, by the same
# error name the cache-side trigger uses — one law, two reachable sites.
case("P1-01 a movement that moves the key away from the per-lot cache is refused AT THE MOVEMENT",
     txn(adjust(2,V_LOT,D(20))+ov(LA,2)),
     "inventory.lot_level_conservation_violated")
# And the scope, which is a limit and not a claim: a key that carries NO
# cache row is still lawful, because the writer that maintains the cache is
# the integration of patch request 3.6 and does not exist at this SHA. The
# case runs on the SECOND warehouse key, which never gets a cache row, so it
# does not depend on running before the cache cases.
case("P1-01 and a key with no per-lot cache at all is still lawful (the half that waits for the writer)",
     txn(adjust(3,V_LOT,D(21),cost=0)+ov(LA,3,var="m",idem=True))
     .replace(f"'{WH}'", f"'{WH2}'")
     +f"SELECT (sl.on_hand >= 3)::text FROM stock_levels sl WHERE sl.business_id='{A}' AND sl.warehouse_id='{WH2}' AND sl.variant_id='{V_LOT}';",
     "true", kind="value")

# And the same refusal evaluated by a NOSUPERUSER NOBYPASSRLS principal at
# COMMIT, which is what the coordinator's relay requires of every fix in this
# round: the minting stands in for the server (in production the API mints the
# assertion out of band, and `daftar_app` holds no EXECUTE on the digest
# helpers — measured: `permission denied for function inventory_fixed_text`,
# and widening that grant to make a test pass is exactly what this project
# forbids), so the command runs as the fixture always ran it and the session
# then becomes `daftar_app` for the COMMIT, where the deferred law is actually
# evaluated. Nothing about the law is taken on trust from the superuser run.
case("P1-01 and the refusal is the same when the COMMIT is judged as daftar_app (NOSUPERUSER NOBYPASSRLS)",
     f"""BEGIN;
       DO $pf$ DECLARE m UUID; BEGIN
         m := fixture_adjust('{D(23)}','{WH}','{V_LOT}',2,0);
         INSERT INTO stock_lot_movements (tenant_id,business_id,stock_movement_id,warehouse_id,variant_id,lot_id,qty_delta)
          VALUES ('{TA}','{A}',m,'{WH}','{V_LOT}','{LA}',2);
       END $pf$;
       SET LOCAL ROLE daftar_app;
     COMMIT;""",
     "inventory.lot_level_conservation_violated")

# P1-02. The deferred check read the movement under RLS and returned silently
# when it could not see it, so the whole law was skipped. The challenger's
# attack: write the movement through the official command, then drop to
# daftar_app and RESET both context settings before COMMIT. Measured at
# b43871b: rc=0, a committed movement of 7 units belonging to no lot.
case("P1-02 a COMMIT that cannot read its own movement is REFUSED, not passed",
     f"""BEGIN;
       DO $pf$ DECLARE m UUID; BEGIN
         m := fixture_adjust('{D(22)}','{WH}','{V_LOT}',7,0);
       END $pf$;
       SET LOCAL ROLE daftar_app;
       RESET app.business_id; RESET app.tenant_id;
     COMMIT;""",
     "inventory.lot_conservation_unverifiable")
# The same arm must not fire on the lawful path, or it is a refusal of
# everything: the happy path above is that case, and this one states it on
# the committed state rather than on an error string.
case("P1-02 and the lawful path still commits (the fail-closed arm is not a blanket refusal)",
     f"SELECT (count(*) > 0)::text FROM stock_lot_movements WHERE business_id='{A}' AND lot_id='{LA}';",
     "true", kind="value")

# P2-03. The definer fold carried no grant, so EXECUTE was PUBLIC: a role
# with no privilege of any kind on the overlay read real quantities through
# it. daftar_reconciler (LOGIN, NOSUPERUSER, NOBYPASSRLS) is the role the
# challenger used, so the proof is run with the same principal.
case("P2-03 a role with no overlay privilege cannot read the table directly",
     f"SELECT count(*) FROM stock_lot_movements;", "permission denied", role="daftar_reconciler")
case("P2-03 nor through the SECURITY DEFINER fold, which is no longer PUBLIC-executable",
     f"SELECT * FROM inventory_lot_fold('{A}','{WH}','{V_LOT}','{LA}');",
     "permission denied", role="daftar_reconciler")
case("P2-03 and the end state says so from the catalogue, not from this test",
     "SELECT has_function_privilege('public','inventory_lot_fold(uuid,uuid,uuid,uuid)','EXECUTE')::text;",
     "false", kind="value")

# P2-04. The fold refused on the business and ANSWERED a confident 0 on the
# tenant, against a lot that really held 3. Both halves of its scope refuse
# now, and the positive case proves it still answers inside its scope.
# As `daftar_app` (LOGIN NOSUPERUSER NOBYPASSRLS), so the answer is measured
# where row-level security is live rather than where a superuser bypasses it.
case("P2-04 the fold still answers inside its own scope",
     f"SELECT (on_hand > 0)::text FROM inventory_lot_fold('{A}','{WH}','{V_LOT}','{LA}');",
     "true", role="daftar_app", kind="value")
case("P2-04 with the tenant context dropped it REFUSES instead of answering 0",
     f"RESET app.tenant_id; SELECT * FROM inventory_lot_fold('{A}','{WH}','{V_LOT}','{LA}');",
     "inventory.scope_mismatch", role="daftar_app")
case("P2-04 and with a FOREIGN tenant it refuses too (the lot is not visible, which is not the same as empty)",
     f"SELECT * FROM inventory_lot_fold('{A}','{WH}','{V_LOT}','{LA}');",
     "inventory.scope_mismatch", role="daftar_app", pre=f"SET app.tenant_id='{TB}'; SET app.business_id='{A}';")

# P3. A lot's dates and receipt order were freely rewritable, which makes a
# refusal policy over an expiry date weaker than it reads.
# These four run as the OWNER (`postgres` here, `daftar_migrator` in the
# deploy line) and not as the inventory principal, and the reason is itself a
# measurement: no runtime role holds UPDATE on `stock_lots` at this SHA —
# the internal principal has SELECT and INSERT on the overlay and UPDATE only
# on the cache's two columns — so an attempt as that role is refused by the
# GRANT and never reaches the guard. The guard therefore has to bind whoever
# CAN write, the owner included, exactly as the append-only law does. The
# merchant-facing correction path needs a grant that does not exist yet, and
# the guard is what that grant will be safe against.
case("P3 a lot that movements name cannot have its expiry date rewritten (the guard binds the OWNER)",
     f"UPDATE stock_lots SET expiry_date='2099-01-01' WHERE business_id='{A}' AND id='{LA}';",
     "inventory.lot_facts_frozen")
case("P3 nor its receipt order, which the picker's index orders by",
     f"UPDATE stock_lots SET received_seq=99 WHERE business_id='{A}' AND id='{LA}';",
     "inventory.lot_facts_frozen")
case("P3 and the inventory principal cannot rewrite a lot fact at all, by the grant",
     INT+f"UPDATE stock_lots SET expiry_date='2099-01-01' WHERE business_id='{A}' AND id='{LA}';",
     "permission denied")
# The lot this case corrects is created by `world_b.sql` and not here: a case
# that CREATES a row another section counts makes that other section's
# expected number depend on the order the suite runs in, which is the defect
# the Pack A round paid for twice.
case("PB10-04 P3 but a lot no movement names is still correctable, because a receipt typo is real",
     f"UPDATE stock_lots SET expiry_date='2027-04-30' WHERE business_id='{A}' AND id='a8000000-0000-0000-0000-0000000000a8';"
     +f"SELECT expiry_date::text FROM stock_lots WHERE business_id='{A}' AND id='a8000000-0000-0000-0000-0000000000a8';"
     +f"UPDATE stock_lots SET expiry_date='2027-03-31' WHERE business_id='{A}' AND id='a8000000-0000-0000-0000-0000000000a8';",
     "2027-04-30", kind="value")
case("PB10-05 P3 and the status of a lot is NOT a fact of the goods: a quarantine is still allowed",
     f"UPDATE stock_lots SET status='blocked' WHERE business_id='{A}' AND id='{LA}';"
     +f"UPDATE stock_lots SET status='active' WHERE business_id='{A}' AND id='{LA}';"
     +f"SELECT status FROM stock_lots WHERE business_id='{A}' AND id='{LA}';",
     "active", kind="value")

# ── PB-15's P3: the lot CODE case, with the masking constraint named ──────
# The second challenge round asked for this case and for its shape. Rewriting
# `lot_code_input` alone is refused by `stock_lots_code_canonical_ck`, the
# CHECK that keeps the stored code and its canonical form in step — a
# constraint that fires first hiding the guard under test, which this phase
# has now paid for three times. So the case that proves the code is frozen
# moves BOTH columns together, and the masking is measured in its own case
# rather than left as a trap for the next reader.
case("P3 a lot that movements name cannot have its CODE rewritten either (both columns moved together)",
     f"UPDATE stock_lots SET lot_code_input='L-A-FIXED', lot_code_norm=catalog_identifier_norm('sku','L-A-FIXED') "
     f"WHERE business_id='{A}' AND id='{LA}';",
     "inventory.lot_facts_frozen")
case("P3 and moving the stored code ALONE is refused by the canonical-form CHECK, not by the guard (the mask, named)",
     f"UPDATE stock_lots SET lot_code_input='L-A-FIXED' WHERE business_id='{A}' AND id='{LA}';",
     "stock_lots_code_canonical_ck")

# ── PB-17. The path the law is NOT enforced on, measured and reversed ─────
# The second challenge round measured it: a bare `UPDATE stock_levels SET
# on_hand = on_hand + 5` is neither a movement nor a cache write, so it fires
# neither conservation trigger and commits a key above its own breakdown.
# Pack B does not close that path — a trigger on `stock_levels` would be this
# phase guarding a FROZEN relation, and the frozen core makes the same bargain
# for its own law (`inventory_stock_verify` is a routine, not a trigger). What
# is owed is this measurement, the privilege list behind it, and the sentence
# in C-LOT-03 that says which paths the law holds on. The case RESTORES the
# key, so the state it measures is not left behind for the next case — which
# the mutation runs could not do and is why they rebuild.
case("PB-17 a direct write to the stock key fires neither conservation trigger, and the exposure is a GRANT (scope, measured)",
     f"UPDATE stock_levels SET on_hand = on_hand + 5 WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';\n"
     f"SELECT 'diverged_by=' || ((SELECT on_hand FROM stock_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}')"
     f"    - (SELECT coalesce(sum(on_hand),0) FROM stock_lot_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}'))::text;\n"
     f"UPDATE stock_levels SET on_hand = on_hand - 5 WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';\n"
     f"SELECT 'restored=' || CASE WHEN (SELECT on_hand FROM stock_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}')"
     f"    = (SELECT coalesce(sum(on_hand),0) FROM stock_lot_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}') THEN 'key=cache' ELSE 'DIVERGED' END;\n"
     # The grant is read at BOTH granularities, because they differ and the
     # difference is the scope sentence's substance: only the migration owner
     # holds table-level UPDATE on the key, while the inventory principal
     # holds it on `on_hand` by COLUMN. The challenger's list named both
     # roles; this names which privilege each one actually has, so a future
     # grant that widens either granularity reds this case.
     f"SELECT 'table_updaters=' || coalesce(string_agg(grantee,',' ORDER BY grantee),'none') FROM information_schema.role_table_grants "
     f" WHERE table_schema='public' AND table_name='stock_levels' AND privilege_type='UPDATE';\n"
     f"SELECT 'on_hand_updaters=' || coalesce(string_agg(grantee,',' ORDER BY grantee),'none') FROM information_schema.column_privileges "
     f" WHERE table_schema='public' AND table_name='stock_levels' AND privilege_type='UPDATE' AND column_name='on_hand';",
     "diverged_by=5.0000\nrestored=key=cache\ntable_updaters=daftar_migrator\non_hand_updaters=daftar_inventory_internal,daftar_migrator", kind="value")
case("PB-17 and the routine that closes it is named in the law, not left to a reader (SPEC ONLY at this SHA)",
     "SELECT 'core_routine=' || (SELECT count(*)::text FROM pg_proc WHERE proname='inventory_stock_verify')"
     " || ' overlay_routine=' || (SELECT count(*)::text FROM pg_proc WHERE proname='inventory_lot_verify');",
     "core_routine=1 overlay_routine=0", kind="value")

# ── D-32. The CACHE side of the same fail-open, found here ────────────────
# Not reported by either round: re-reading this trigger against the fix the
# challenge forced on its twin showed the same `RETURN NULL` on `NOT FOUND`.
# The key cannot be absent — `stock_lot_levels_level_fk` guarantees it, and an
# FK check ignores RLS — so `NOT FOUND` means the row exists and this
# transaction cannot read it, which is the Phase 5 class exactly. The attack
# is therefore the invisibility one, in the shape the challenger used on the
# movement side: write the cache row lawfully, then drop the context before
# COMMIT so the deferred read comes back empty.
case("D-32 a COMMIT that cannot read the stock key behind its own cache row is REFUSED, not passed",
     f"""BEGIN;
       SET ROLE daftar_inventory_internal;
       UPDATE stock_lot_levels SET on_hand = on_hand WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';
       RESET ROLE;
       SET LOCAL ROLE daftar_app;
       RESET app.business_id; RESET app.tenant_id;
     COMMIT;""",
     "inventory.lot_conservation_unverifiable")
case("D-32 and the lawful cache write still commits, so the arm is not a blanket refusal",
     f"""BEGIN;
       SET ROLE daftar_inventory_internal;
       UPDATE stock_lot_levels SET on_hand = on_hand WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';
       RESET ROLE;
     COMMIT;
     SELECT 'lawful=' || CASE WHEN (SELECT on_hand FROM stock_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}')
         = (SELECT coalesce(sum(on_hand),0) FROM stock_lot_levels WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}') THEN 'key=cache' ELSE 'DIVERGED' END;""",
     "lawful=key=cache", kind="value")

w=max(len(c[0]) for c in cases); v=max(len(c[1]) for c in cases)
print(f"{'case':<{w}} {'verdict':<{v}} detail")
print("-"*(w+v+60))
for c in cases: print(f"{c[0]:<{w}} {c[1]:<{v}} {c[2]}")
failed=[c for c in cases if "FAILED" in c[1]]
print(f"\nPACK B TOTAL {len(cases)} cases, {len(failed)} failed")
sys.exit(1 if failed else 0)
