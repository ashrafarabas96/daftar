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
import subprocess, sys
import os
# The cluster is named by the environment so the harness can create its own
# on-target cluster and every script agrees on which one ran (finding P2-09).
SOCK=os.environ.get("P11_SOCK","/var/tmp/p11u/run"); PORT=os.environ.get("P11_PORT","55512"); DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
A='aaaaaaaa-0000-0000-0000-00000000000a'; B='bbbbbbbb-0000-0000-0000-00000000000b'
TA='11111111-1111-1111-1111-111111111111'; TB='22222222-2222-2222-2222-222222222222'
WH='7c000000-0000-0000-0000-00000000007c'
P_LOT='7d000000-0000-0000-0000-00000000007d'; P_NOLOT='7e000000-0000-0000-0000-00000000007e'
ACTOR='99999999-0000-0000-0000-000000000099'

CTX=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';\n"

def run(sql, role="postgres", pre=CTX):
    cmd=[PSQL,"-h",SOCK,"-p",PORT,"-U",role,"-d",DB,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-f","-"]
    r=subprocess.run(["su","postgres","-s","/bin/bash","-c"," ".join(cmd)], input=pre+sql, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

cases=[]
def case(name, sql, expect, role="postgres", pre=CTX, kind="refusal"):
    rc,out,err=run(sql,role,pre)
    if kind=="refusal":
        ok = rc!=0 and expect in err
        detail=(err.splitlines()[0] if err else "no error") if not ok else expect
    else:
        ok = rc==0 and expect in out
        detail=(out or err.splitlines()[0] if err else out) if not ok else expect
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
        VALUES ('{TA}','{A}','{WH}','{V_LOT}',0,0,0),('{TA}','{A}','{WH}','{V_NOLOT}',0,0,0);
      INSERT INTO stock_lots (tenant_id,business_id,id,variant_id,lot_code_norm,lot_code_input,expiry_date,received_seq)
        VALUES ('{TA}','{A}','a1000000-0000-0000-0000-0000000000a1','{V_LOT}',catalog_identifier_norm('sku','L-A'),'L-A','2027-01-31',1),
               ('{TA}','{A}','a2000000-0000-0000-0000-0000000000a2','{V_LOT}',catalog_identifier_norm('sku','L-B'),'L-B','2026-12-31',2);
    """)
    if rc!=0:
        print("HARNESS SETUP FAILED — refusing to report proofs it did not run:"); print(" ", err.splitlines()[0] if err else out); sys.exit(2)
lots_setup()

LA='a1000000-0000-0000-0000-0000000000a1'; LB='a2000000-0000-0000-0000-0000000000a2'
M=lambda n: f"b{n}000000-0000-0000-0000-0000000000b{n}"

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

def ov(lot, qty, variant=None, var="m"):
    return (f"  INSERT INTO stock_lot_movements (tenant_id,business_id,stock_movement_id,warehouse_id,variant_id,lot_id,qty_delta)"
            f" VALUES ('{TA}','{A}',{var},'{WH}','{variant or V_LOT}','{lot}',{qty});\n")

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
case("the happy path: a lot-tracked movement whose allocation sums exactly",
     txn(adjust(10,V_LOT,M(4))+ov(LA,6)+ov(LB,4))
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
case("the per-lot cache cannot disagree with the stock key's on-hand",
     INT+f"""BEGIN;
       UPDATE stock_levels SET on_hand=10 WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';
       INSERT INTO stock_lot_levels (tenant_id,business_id,warehouse_id,variant_id,lot_id,on_hand,last_movement_seq)
         VALUES ('{TA}','{A}','{WH}','{V_LOT}','{LA}',6,101);
       COMMIT;""",
     "inventory.lot_level_conservation_violated")
case("and it commits when it does agree",
     INT+f"""BEGIN;
       UPDATE stock_levels SET on_hand=10 WHERE business_id='{A}' AND warehouse_id='{WH}' AND variant_id='{V_LOT}';
       INSERT INTO stock_lot_levels (tenant_id,business_id,warehouse_id,variant_id,lot_id,on_hand,last_movement_seq)
         VALUES ('{TA}','{A}','{WH}','{V_LOT}','{LA}',6,101),('{TA}','{A}','{WH}','{V_LOT}','{LB}',4,101);
       COMMIT;
       SELECT sum(on_hand)::text FROM stock_lot_levels WHERE business_id='{A}' AND variant_id='{V_LOT}';""",
     "10", kind="value")
case("a negative per-lot on-hand", INT+f"UPDATE stock_lot_levels SET on_hand=-1 WHERE business_id='{A}' AND lot_id='{LA}';",
     "stock_lot_levels_on_hand_ck")

# ── 6. the fold, and its scope guard ─────────────────────────────────────
case("the fold reports the lot's own quantity from the movements, not the cache",
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
case("with business A's own context the same lots ARE visible",
     f"SELECT count(*)::text FROM stock_lots;", "2", role="daftar_app", kind="value")
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

w=max(len(c[0]) for c in cases); v=max(len(c[1]) for c in cases)
print(f"{'case':<{w}} {'verdict':<{v}} detail")
print("-"*(w+v+60))
for c in cases: print(f"{c[0]:<{w}} {c[1]:<{v}} {c[2]}")
failed=[c for c in cases if "FAILED" in c[1]]
print(f"\nPACK B TOTAL {len(cases)} cases, {len(failed)} failed")
sys.exit(1 if failed else 0)
