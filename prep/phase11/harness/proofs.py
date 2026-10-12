import subprocess, sys, json
import os
# The cluster is named by the environment so the harness can create its own
# on-target cluster and every script agrees on which one ran (finding P2-09).
SOCK=os.environ.get("P11_SOCK","/var/tmp/p11u/run"); PORT=os.environ.get("P11_PORT","55512"); DB="daftar"
PSQL="/usr/lib/postgresql/16/bin/psql"
A='aaaaaaaa-0000-0000-0000-00000000000a'; PA='dddddddd-0000-0000-0000-00000000000d'
B='bbbbbbbb-0000-0000-0000-00000000000b'
TA='11111111-1111-1111-1111-111111111111'; TB='22222222-2222-2222-2222-222222222222'

def run(sql, role="postgres", pre=""):
    cmd=[PSQL,"-h",SOCK,"-p",PORT,"-U",role,"-d",DB,"-X","-q","-A","-t","-v","ON_ERROR_STOP=1","-f","-"]
    r=subprocess.run(["su","postgres","-s","/bin/bash","-c"," ".join(cmd)], input=pre+sql, capture_output=True, text=True)
    return r.returncode, r.stdout.strip(), r.stderr.strip()

cases=[]
def case(name, sql, expect, role="postgres", pre="", kind="refusal"):
    rc,out,err=run(sql,role,pre)
    if kind=="refusal":
        ok = rc!=0 and expect in err
        detail = (err.splitlines()[0] if err else "no error") if not ok else expect
    else:
        ok = rc==0 and expect in out
        detail = out if not ok else expect
    cases.append((name, "RED (refused as required)" if (ok and kind=="refusal") else ("GREEN" if ok else "**PROOF FAILED**"), detail))
    return ok

PE='dddddddd-0000-0000-0000-00000000000e'   # the variant-free apparel product
V=lambda vid,attrs,base='false': f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) VALUES ('{A}','{vid}','{PA}','{attrs}'::jsonb,{base});"

# ── IDEMPOTENCE, which is finding P3-N03's companion ──────────────────────
# The second independent challenger measured that this suite was NOT
# idempotent: a second run against the same database failed seven cases with
# no mutation at all, because its own writes persisted — the happy-path
# variant, the plain-product variant and the registry rows it adds. The
# harness always rebuilds from zero, so it never bit the author; it cost the
# challenger a run and would mislead any reviewer who re-ran the suite for a
# quick check. It is also a correctness risk in the direction that matters:
# a mutation measured on a re-run measures the re-run.
#
# So every write this suite makes that OUTLIVES its case is written
# conflict-tolerantly (`ON CONFLICT DO NOTHING`, or a normalizing UPDATE
# before the case's own transition), and the cases assert the COMMITTED
# STATE afterwards rather than the fact of an insert — which is the shape
# this phase already uses everywhere else. The claim is proved rather than
# asserted: the harness runs this file TWICE on the same database and
# requires exit 0 both times (step 6a2 of rebuild_and_prove.sh).
IDEM = " ON CONFLICT DO NOTHING;"

# 1 happy path, and WHERE the canonical form actually comes from
case("happy path: a registered combination is accepted",
     V('f0000001-0000-0000-0000-000000000001','{"size":"s","color":"red"}').replace(";",IDEM)+
     f"SELECT attributes::text FROM product_variants WHERE id='f0000001-0000-0000-0000-000000000001';",
     '{"size": "s", "color": "red"}', kind="value")
case("jsonb itself canonicalizes key order, which is what makes the index work",
     "SELECT ('{\"size\":\"s\",\"color\":\"red\"}'::jsonb = '{\"color\":\"red\",\"size\":\"s\"}'::jsonb)::text;",
     "t", kind="value")

# 2 shape
case("attributes is an array, not an object", V('f0000002-0000-0000-0000-000000000002','[]'),
     "catalog.variant_attributes_shape_invalid")
case("attributes has a nested value", V('f0000003-0000-0000-0000-000000000003','{"size":{"a":1}}'),
     "catalog.variant_attributes_shape_invalid")
case("attributes has a non-text value", V('f0000004-0000-0000-0000-000000000004','{"size":3}'),
     "catalog.variant_attributes_shape_invalid")

# 3 registry
case("an axis the product's matrix does not register",
     V('f0000005-0000-0000-0000-000000000005','{"size":"s","fit":"slim"}'),
     "catalog.variant_axis_unregistered")
case("a value that exists but is archived",
     V('f0000006-0000-0000-0000-000000000006','{"size":"xl_archived","color":"red"}'),
     "catalog.variant_axis_value_unregistered")
case("a value that does not exist at all",
     V('f0000007-0000-0000-0000-000000000007','{"size":"xxxl","color":"red"}'),
     "catalog.variant_axis_value_unregistered")

# 4 closure
case("a partial combination (one of two registered axes)",
     V('f0000008-0000-0000-0000-000000000008','{"size":"s"}'),
     "catalog.variant_axis_set_incomplete")
case("a product with no registered axes cannot carry attributes",
     f"INSERT INTO product_variants (business_id,id,product_id,attributes) VALUES ('{B}','f0000009-0000-0000-0000-000000000009','eeeeeeee-0000-0000-0000-00000000000e','{{\"size\":\"s\"}}'::jsonb);",
     "catalog.variant_axis_unregistered")

# 5 base: the EXISTING guard owns this, and Pack A adds no refusal for it
case("a base variant write is refused by the pre-existing authority, not by Pack A",
     V('f000000a-0000-0000-0000-00000000000a','{"size":"s","color":"red"}','true'),
     "catalog.base_variant_not_mutable")

# 6 uniqueness, and that canonicalization makes key ORDER irrelevant
case("the same combination twice", V('f000000b-0000-0000-0000-00000000000b','{"size":"s","color":"red"}'),
     "product_variants_matrix_uq")
case("the same combination with the keys written in the other order",
     V('f000000c-0000-0000-0000-00000000000c','{"color":"red","size":"s"}'),
     "product_variants_matrix_uq")

# 7 the stock lock: stock_levels row written as the internal owner
# The internal principal is on USING only, never WITH CHECK, so its insert
# needs the session's business context set — which is the documented design,
# and the test's first shape (no context) was wrong, not the pack.
pre_lock = f"SET app.tenant_id='{TA}'; SET app.business_id='{A}'; INSERT INTO branches (business_id,id,name) VALUES ('{A}','{A}','BR') ON CONFLICT DO NOTHING; INSERT INTO warehouses (business_id,id,branch_id,name) VALUES ('{A}','{A}','{A}','WH') ON CONFLICT DO NOTHING; SET ROLE daftar_inventory_internal; INSERT INTO stock_levels (tenant_id,business_id,warehouse_id,variant_id,on_hand,valuation_base_minor,last_stock_seq) VALUES ('{TA}','{A}','{A}','f0000001-0000-0000-0000-000000000001',1,0,0) ON CONFLICT DO NOTHING; RESET ROLE;"
case("attributes changed at all (the combination is the identity)",
     f"UPDATE product_variants SET attributes='{{\"size\":\"m\",\"color\":\"red\"}}'::jsonb WHERE id='f0000001-0000-0000-0000-000000000001';",
     "catalog.variant_matrix_immutable", pre=pre_lock)
case("an axis named by existing variants cannot be removed",
     f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PA}' AND axis_code='color';",
     "catalog.matrix_axis_in_use")

# ── 7b. THE REMOVAL DIRECTION ─────────────────────────────────────────────
# Every case above tests a law in the INSERT direction. The independent
# challenge at 1a8ba15 found that three clauses of C-APP-01 are defeated by a
# single UPDATE or DELETE statement, with no concurrency at all, and that the
# suite's 21 green cases never reached them. These are those cases, one per
# finding, each naming the constraint or error that must refuse it.

# P0-01. The one value the trigger used to return early on. The variant below
# holds `on_hand 5.0000`... in fact it holds the stock_levels row created in
# pre_lock above, which is what made this finding a split stock identity
# rather than a cosmetic blank.
case("P0-01 the combination cannot be BLANKED either (the early return used to allow it)",
     f"UPDATE product_variants SET attributes='{{}}'::jsonb WHERE id='f0000001-0000-0000-0000-000000000001';",
     "catalog.variant_matrix_immutable")
case("P0-01 and the cell therefore still has exactly ONE stock identity",
     f"SELECT count(*)::text FROM product_variants WHERE business_id='{A}' AND product_id='{PA}' AND NOT is_base"
     f" AND attributes = '{{\"size\": \"s\", \"color\": \"red\"}}'::jsonb;", "1", kind="value")
# The limit of the fix, measured rather than asserted: a product that
# registers no axes DOES legitimately carry a non-base variant with no
# combination, which is why the structural CHECK the challenge proposed
# (`is_base OR attributes <> '{}'`) is not available.
case("a plain product's non-base variant may carry no combination at all (why the CHECK is unavailable)",
     f"INSERT INTO product_variants (business_id,id,product_id,attributes) VALUES ('{B}','f0000010-0000-0000-0000-000000000010','eeeeeeee-0000-0000-0000-00000000000e','{{}}'::jsonb) ON CONFLICT DO NOTHING;"
     f"SELECT count(*)::text FROM product_variants WHERE id='f0000010-0000-0000-0000-000000000010';",
     "1", kind="value")
case("and ITS combination is immutable in the other direction too",
     f"UPDATE product_variants SET attributes='{{\"size\":\"s\"}}'::jsonb WHERE id='f0000010-0000-0000-0000-000000000010';",
     "catalog.variant_matrix_immutable")

# P0-02 / P1-03. The value registry, which had no guard on any removal path.
case("P0-02 a value named by existing variants cannot be DELETED",
     f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='red';",
     "catalog.attribute_value_in_use")
case("P1-03 nor ARCHIVED (the non-key UPDATE the FOR KEY SHARE lock did not cover)",
     f"UPDATE product_attribute_values SET status='archived' WHERE business_id='{A}' AND axis_code='color' AND value_code='red';",
     "catalog.attribute_value_in_use")
case("P1-03 nor REPOINTED to another code, which is the same removal",
     f"UPDATE product_attribute_values SET value_code='crimson' WHERE business_id='{A}' AND axis_code='color' AND value_code='red';",
     "catalog.attribute_value_in_use")
# The guard is a guard and not a blanket refusal: an UNUSED value is still
# archivable, which is the lifecycle the registry exists for. The pair runs
# on a value this file REGISTERS for the purpose, not on the world's `l`:
# `l` is a size race B2 names in a committed variant, so "no variant names
# it" was true only while proofs.py ran before races.py — a case whose
# verdict depended on the order the harness happens to call its files in,
# which is the same defect class as the suite's non-idempotence and was
# found by the same measurement (a third run, after the races).
ARCHIVABLE = "archivable_probe"
case("a value no variant names is still archivable (the guard refuses removal, not administration)",
     f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','size','{ARCHIVABLE}',90) ON CONFLICT DO NOTHING;"
     f"UPDATE product_attribute_values SET status='archived' WHERE business_id='{A}' AND axis_code='size' AND value_code='{ARCHIVABLE}';"
     f"SELECT status FROM product_attribute_values WHERE business_id='{A}' AND axis_code='size' AND value_code='{ARCHIVABLE}';",
     "archived", kind="value")
case("and un-archiving it is not a removal either",
     f"UPDATE product_attribute_values SET status='active' WHERE business_id='{A}' AND axis_code='size' AND value_code='{ARCHIVABLE}';"
     f"SELECT status FROM product_attribute_values WHERE business_id='{A}' AND axis_code='size' AND value_code='{ARCHIVABLE}';",
     "active", kind="value")

# P1-04. The axis-in-use guard was BEFORE DELETE only.
case("P1-04 an axis in use cannot be REPOINTED either (an UPDATE is the same removal)",
     f"UPDATE product_matrix_axes SET axis_code='material' WHERE business_id='{A}' AND product_id='{PA}' AND axis_code='color';",
     "catalog.matrix_axis_in_use")
case("P1-04 and the matrix still registers exactly its two axes",
     f"SELECT string_agg(axis_code,',' ORDER BY axis_position)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PA}';",
     "size,color", kind="value")
case("an axis named by existing variants can be neither renamed nor archived in the REGISTRY",
     f"UPDATE product_attribute_axes SET status='archived' WHERE business_id='{A}' AND axis_code='color';",
     "catalog.attribute_axis_in_use")

# P2-06. `status` on the axis registry was decoration.
# Both cases run on the VARIANT-FREE product (TSHIRT-EMPTY): since P1-N01's
# fix freezes the axis set of a populated matrix, a matrix write on TSHIRT
# would be refused by the freeze guard and the guard under test would never
# be reached. A constraint that fires first hides the one you are proving.
case("P2-06 an ARCHIVED axis cannot be added to a product's matrix",
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order,status) VALUES ('{A}','fit',9,'archived') ON CONFLICT DO NOTHING;"
     f"UPDATE product_attribute_axes SET status='archived' WHERE business_id='{A}' AND axis_code='fit';"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PE}','fit',3);",
     "catalog.variant_axis_archived")

# ── P1-N01. THE ADD DIRECTION, the finding that held the scope back ───────
# C-APP-01's first clause is "a matrix product's variant attributes name
# exactly its registered axis set". Round 1 found it enforced on the VARIANT
# insert only; this round added every removal path on both registries. The
# remaining direction was adding an axis to a matrix that already has
# variants, and nothing refused it: measured at 23a7139, the INSERT returned
# rc=0, the matrix registered three axes, and a committed 2-axis variant
# became unaddressable through the matrix while keeping its own stock key.
case("P1-N01 an axis cannot be ADDED to a matrix that already has variants",
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','material',12) ON CONFLICT DO NOTHING;"
     f"UPDATE product_attribute_axes SET status='active' WHERE business_id='{A}' AND axis_code='material';"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PA}','material',3);",
     "catalog.matrix_axis_set_frozen")
case("P1-N01 and the populated product still registers exactly its two axes",
     f"SELECT string_agg(axis_code,',' ORDER BY axis_position)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PA}';",
     "size,color", kind="value")
# The challenger's own committed-state measurement, run as a case: no
# non-base variant of a matrix product names anything but exactly the set
# its product registers — neither a subset nor a superset nor an axis the
# matrix does not carry.
# Restated over LIVE variants in round 3, with the reason written down rather
# than quietly narrowed: finding PA-02's fix makes ARCHIVED variants outside
# the grid (they do not freeze the axis set, and `product_variants_matrix_uq`
# has excluded them since round 0), so C-APP-01 is a law about live non-base
# variants. An archived 2-axis row on a product that has since registered a
# third axis is the INTENDED end state of the recovery path, and a case that
# counted it would red the very path the pack now promises. The archived rows
# are not unexamined: the case below asserts how many there are and that each
# one holds no stock.
case("P1-N01 and no committed LIVE variant of this business names other than exactly its product's registered set",
     f"""SELECT count(*)::text FROM product_variants v
          WHERE v.business_id='{A}' AND NOT v.is_base AND v.status <> 'archived'
            AND EXISTS (SELECT 1 FROM product_matrix_axes ma
                         WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id)
            AND ( (SELECT count(*) FROM product_matrix_axes ma
                    WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id)
                  <> (SELECT count(*) FROM jsonb_each(v.attributes))
               OR EXISTS (SELECT 1 FROM jsonb_each(v.attributes) e
                           WHERE NOT EXISTS (SELECT 1 FROM product_matrix_axes ma
                                              WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id
                                                AND ma.axis_code=e.key)) );""",
     "0", kind="value")
# And it is a freeze, not a ban: a grid nobody has populated is still the
# merchant's to build. The row is removed again so the suite leaves the
# product as it found it (idempotence).
case("P1-N01 the freeze is on POPULATED matrices only: an empty grid can still be extended",
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PE}','material',3) ON CONFLICT DO NOTHING;"
     f"SELECT count(*)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PE}';"
     f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PE}' AND axis_code='material';",
     "3", kind="value")


# ── PA-01. THE THIRD DOOR of C-APP-01: a '{}' non-base variant ────────────
# Third independent challenge, measured at 0db9450: on the world's TSHIRT,
# which registers two axes and holds one committed cell, a non-base variant
# with `attributes='{}'` was ACCEPTED (rc=0) and took its own stock key
# (5.0000). One matrix cell set, one row outside it, both holding stock —
# the same state P0-01 reached by blanking and P1-N01 reached by adding an
# axis, reached this time by a single INSERT. The guard is now derived from
# that STATE rather than from the reported statement; see the comment in
# product_variants_40_matrix_canonical().
case("PA-01 a '{}' non-base variant is refused on a product that HAS a matrix",
     V('f0000020-0000-0000-0000-000000000020','{}'),
     "catalog.variant_axis_set_incomplete")
case("PA-01 and on a matrix product whose grid is still EMPTY, which is about the matrix and not about the cells",
     f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) VALUES ('{A}','f0000021-0000-0000-0000-000000000021','{PE}','{{}}'::jsonb,false);",
     "catalog.variant_axis_set_incomplete")
case("PA-01 and no committed non-base variant of a MATRIX product carries an empty combination",
     f"""SELECT count(*)::text FROM product_variants v
          WHERE v.business_id='{A}' AND NOT v.is_base AND v.attributes = '{{}}'::jsonb
            AND EXISTS (SELECT 1 FROM product_matrix_axes ma
                         WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id);""",
     "0", kind="value")

# ── PA-02. The recovery path the freeze guard offers, END TO END ───────────
# The guard tells the merchant to archive the cells at zero stock and
# regenerate the grid. Measured at 0db9450: the archive was permitted and the
# next step was still refused, because the freeze read had no `status`
# filter — a recovery path that existed only in a comment. The whole
# sequence now runs as one case, on its own product, and every statement in
# it is conditional so the case measures the same thing on a second run
# (the variant INSERT in particular: a BEFORE trigger fires before ON
# CONFLICT can apply, so `WHERE NOT EXISTS` is what makes it idempotent).
PR='dddddddd-0000-0000-0000-00000000000f'
case("PA-02 the documented recovery runs: archive the cells at zero stock, register another axis, regenerate the grid",
     # 1. two cells on the product whose grid is to be corrected. TWO, and
     #    not one, because the residual case below posts stock onto an
     #    archived cell: measured on a second run, a single cell made the
     #    premise case ("the archived cell holds no stock") depend on whether
     #    the residual case had run yet, which is the order dependence this
     #    suite has now been bitten by twice. One archived cell is the
     #    subject of the premise, the other of the residual.
     f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) "
     f"SELECT '{A}','f0000022-0000-0000-0000-000000000022','{PR}','{{\"size\":\"s\",\"color\":\"red\"}}'::jsonb,false "
     f"WHERE NOT EXISTS (SELECT 1 FROM product_variants WHERE business_id='{A}' AND id='f0000022-0000-0000-0000-000000000022');\n"
     f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) "
     f"SELECT '{A}','f0000024-0000-0000-0000-000000000024','{PR}','{{\"size\":\"m\",\"color\":\"blue\"}}'::jsonb,false "
     f"WHERE NOT EXISTS (SELECT 1 FROM product_variants WHERE business_id='{A}' AND id='f0000024-0000-0000-0000-000000000024');\n"
     # 2. archive them both (the pack permits this at zero stock). A BEFORE
     #    trigger fires before ON CONFLICT can apply, so every write in this
     #    case is conditional rather than conflict-tolerant.
     f"UPDATE product_variants SET status='archived' WHERE business_id='{A}' "
     f" AND id IN ('f0000022-0000-0000-0000-000000000022','f0000024-0000-0000-0000-000000000024') AND status <> 'archived';\n"
     # 3. the step that was refused before this round
     f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','material','cotton',1) ON CONFLICT DO NOTHING;\n"
     # Conditional for the same reason as the variant writes, and this one
     # cost a run to learn: on a second run the regenerated 3-axis cell is
     # LIVE, so `ON CONFLICT DO NOTHING` is not reached — the freeze guard is
     # a BEFORE trigger and fires first. An idempotent statement is one that
     # does not fire a trigger it does not need, not one that tolerates a
     # conflict.
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) "
     f"SELECT '{A}','{PR}','material',3 WHERE NOT EXISTS (SELECT 1 FROM product_matrix_axes "
     f" WHERE business_id='{A}' AND product_id='{PR}' AND axis_code='material');\n"
     # 4. and the regenerated grid accepts a 3-axis cell
     f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) "
     f"SELECT '{A}','f0000023-0000-0000-0000-000000000023','{PR}','{{\"size\":\"s\",\"color\":\"red\",\"material\":\"cotton\"}}'::jsonb,false "
     f"WHERE NOT EXISTS (SELECT 1 FROM product_variants WHERE business_id='{A}' AND id='f0000023-0000-0000-0000-000000000023');\n"
     f"SELECT 'axes=' || count(*)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PR}';\n"
     f"SELECT 'live_cells=' || count(*)::text FROM product_variants WHERE business_id='{A}' AND product_id='{PR}' AND NOT is_base AND status <> 'archived';\n"
     f"SELECT 'archived_cells=' || count(*)::text FROM product_variants WHERE business_id='{A}' AND product_id='{PR}' AND NOT is_base AND status = 'archived';",
     "axes=3\nlive_cells=1\narchived_cells=2", kind="value")
# The fix is a filter, not a removal: a LIVE cell still freezes the set,
# which is P1-N01's case on TSHIRT, and the first archived cell on this
# product holds no stock, which is the premise the filter rests on
# (product_variants_30_archive_requires_zero_stock, 0061).
case("PA-02 and the archived cell holds no stock, which is what makes it outside the grid",
     f"""SELECT 'keyed=' || (SELECT count(*)::text FROM stock_levels l
                              WHERE l.business_id='{A}' AND l.variant_id='f0000022-0000-0000-0000-000000000022'
                                AND l.on_hand <> 0)
         || ' moved=' || (SELECT count(*)::text FROM stock_movements m
                           WHERE m.business_id='{A}' AND m.variant_id='f0000022-0000-0000-0000-000000000022');""",
     "keyed=0 moved=0", kind="value")
# The RESIDUAL of that fix, measured rather than reasoned about: nothing in
# the frozen core refuses a stock key on an archived variant, so the sequence
# "archive, add an axis, then post stock onto the archived cell" reaches the
# unaddressable state one authority further on. Pack A cannot close it here
# (reading stock_levels from the matrix guard is a cross-table read of an
# ABSENT row, which cannot be locked). It is MPR-09, and it is measured so
# the limit is a number in a log rather than a sentence in a comment.
case("PA-02 residual: a stock key on the OTHER archived cell is accepted today, and no trigger on the key reads variant status (MPR-09)",
     f"SET ROLE daftar_inventory_internal;\n"
     f"INSERT INTO stock_levels (tenant_id,business_id,warehouse_id,variant_id,on_hand,valuation_base_minor,last_stock_seq) "
     f"SELECT '{TA}','{A}','{A}','f0000024-0000-0000-0000-000000000024',5,0,0 "
     f"WHERE NOT EXISTS (SELECT 1 FROM stock_levels WHERE business_id='{A}' AND warehouse_id='{A}' AND variant_id='f0000024-0000-0000-0000-000000000024');\n"
     f"RESET ROLE;\n"
     f"SELECT 'archived_variant_on_hand=' || on_hand::text FROM stock_levels WHERE business_id='{A}' AND variant_id='f0000024-0000-0000-0000-000000000024';\n"
     f"SELECT 'triggers_reading_variant_status=' || count(*)::text FROM pg_trigger g JOIN pg_proc pr ON pr.oid=g.tgfoid "
     f"WHERE NOT g.tgisinternal AND g.tgrelid IN ('stock_levels'::regclass,'stock_movements'::regclass) "
     f"AND position('product_variants' in catalog_prosrc_uncommented(pr.oid::regprocedure::text)) > 0 "
     f"AND position('status' in catalog_prosrc_uncommented(pr.oid::regprocedure::text)) > 0;",
     "archived_variant_on_hand=5.0000\ntriggers_reading_variant_status=0",
     kind="value", pre=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}'; INSERT INTO branches (business_id,id,name) VALUES ('{A}','{A}','BR') ON CONFLICT DO NOTHING; INSERT INTO warehouses (business_id,id,branch_id,name) VALUES ('{A}','{A}','{A}','WH') ON CONFLICT DO NOTHING;")
# And the freeze still holds while a cell is LIVE on the SAME product, which
# is what makes the filter a filter: the regenerated 3-axis cell above is
# live, so a fourth axis is refused.
case("PA-02 and once the grid is live again, the axis set is frozen again (the filter is not an opening)",
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','fabric',14) ON CONFLICT DO NOTHING;"
     f"UPDATE product_attribute_axes SET status='active' WHERE business_id='{A}' AND axis_code='fabric';"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PR}','fabric',4);",
     "catalog.matrix_axis_set_frozen")

# ── P1-01. THE FOURTH DOOR, and the law moved onto the STATE ──────────────
# Fourth independent challenge, measured at 04d87b3:
#   archive both cells             -> permitted (0061 requires zero stock, held)
#   register a third axis          -> permitted (no LIVE variant, so not frozen)
#   UPDATE ... SET status='active' -> rc=0
# and the committed state was one live non-base variant naming two of three
# axes, holding 7.0000. The verb was made reachable by the PREVIOUS round's
# own fix (the `status` filter on the freeze guard, finding PA-02), and
# nothing watched it: the canonicalization trigger fires on UPDATE OF
# attributes, is_base, product_id -- not of status -- and 0061 fires only on
# the way INTO 'archived'.
#
# The answer is not a fifth column in a trigger's list. C-APP-01 is checked
# at COMMIT now, by DEFERRABLE INITIALLY DEFERRED constraint triggers on all
# four relations the state is written from, for INSERT, UPDATE and DELETE
# alike. The refusal names the site ("deferred grid closure at COMMIT") so a
# pair-drop can tell which defence answered.
#
# On its OWN product, for a reason this suite has now paid for twice: the
# first draft of these cases grew TSHIRT-RECOVER's grid to four axes and red
# the recovery case that asserts it has three. One product per lifecycle.
PG='dddddddd-0000-0000-0000-000000000011'
G1='f0000031-0000-0000-0000-000000000031'
G2='f0000032-0000-0000-0000-000000000032'
G3='f0000033-0000-0000-0000-000000000033'
# Step 0, the premise: a populated 2-axis grid, archived at zero stock, and a
# third axis registered on it -- the state the fourth door opens from. Every
# write is conditional, so the case measures the same thing on a second run.
case("P1-01 premise: a 2-axis grid is archived at zero stock and a third axis is then registered",
     f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) "
     f"SELECT '{A}','{G1}','{PG}','{{\"size\":\"s\",\"color\":\"red\"}}'::jsonb,false "
     f"WHERE NOT EXISTS (SELECT 1 FROM product_variants WHERE business_id='{A}' AND id='{G1}');\n"
     # EVERY live cell of this product, not only the one just created: on a
     # second run the cell the un-archive case below leaves active is still
     # live, and a premise that archived one named cell would then measure
     # `live=1` and red. The suite's own writes are part of the state it
     # starts from, which is the lesson that cost this file two runs already.
     f"UPDATE product_variants SET status='archived' WHERE business_id='{A}' AND product_id='{PG}' AND NOT is_base AND status <> 'archived';\n"
     f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','material','cotton',1) ON CONFLICT DO NOTHING;\n"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) "
     f"SELECT '{A}','{PG}','material',3 WHERE NOT EXISTS (SELECT 1 FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PG}' AND axis_code='material');\n"
     f"SELECT 'axes=' || count(*)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PG}';\n"
     f"SELECT 'live=' || count(*)::text FROM product_variants WHERE business_id='{A}' AND product_id='{PG}' AND NOT is_base AND status <> 'archived';",
     "axes=3\nlive=0", kind="value")
case("P1-01 un-archiving a 2-axis cell onto a 3-axis grid is refused at COMMIT (the fourth door)",
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G1}';",
     "catalog.variant_axis_set_incomplete")
case("P1-01 and the refusal comes from the deferred state check, not from a per-verb guard",
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G1}';",
     "deferred grid closure at COMMIT")
# The same statement inside a multi-statement transaction, because a deferred
# check that only answered for single-statement transactions would be a check
# on psql's autocommit rather than on the law. The SELECT between the two
# shows the statement itself was accepted and the COMMIT is what refuses.
case("P1-01 and inside a multi-statement transaction it is the COMMIT that refuses",
     f"BEGIN;\n"
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G1}';\n"
     f"SELECT 'the statement itself was accepted';\n"
     f"COMMIT;",
     "catalog.variant_axis_set_incomplete")
# The grid is regenerated the lawful way, in ONE transaction, which is the
# case that shows why the check is DEFERRED: the axes are written before the
# cells, so every intermediate state of a grid build names fewer cells than
# axes. An IMMEDIATE copy of this check would refuse the ordinary act of
# building a matrix product, which is why the end-state assertion pins
# tginitdeferred.
case("P1-01 the law is on the COMMITTED state: a grid is built in one transaction through states it would refuse",
     f"BEGIN;\n"
     f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) "
     f"SELECT '{A}','{G2}','{PG}','{{\"size\":\"s\",\"color\":\"red\",\"material\":\"cotton\"}}'::jsonb,false "
     f"WHERE NOT EXISTS (SELECT 1 FROM product_variants WHERE business_id='{A}' AND id='{G2}');\n"
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G2}' AND status <> 'active';\n"
     f"SELECT 'live=' || count(*)::text FROM product_variants WHERE business_id='{A}' AND product_id='{PG}' AND NOT is_base AND status <> 'archived';\n"
     f"COMMIT;",
     "live=1", kind="value")
# And it is a LAW, not a ban on un-archiving: a cell whose combination IS the
# current grid comes back. Archived and un-archived in one case, so the suite
# leaves the product as it found it.
case("P1-01 a cell that matches the CURRENT grid can be archived and un-archived",
     f"UPDATE product_variants SET status='archived' WHERE business_id='{A}' AND id='{G2}' AND status <> 'archived';\n"
     f"SELECT 'archived=' || status FROM product_variants WHERE id='{G2}';\n"
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G2}';\n"
     f"SELECT 'back=' || status FROM product_variants WHERE id='{G2}';",
     "archived=archived\nback=active", kind="value")
# The multi-statement REACH: a transaction whose every statement is
# permissible on its own and whose committed state is forbidden. The axis is
# created inside the transaction, so the refusal rolls it back and the
# business's axis count is left as it was -- which is also why this case can
# run twice.
case("P1-01 a transaction that registers an axis while the cells are archived and then un-archives one is refused at COMMIT",
     f"BEGIN;\n"
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','gridaxis5',93);\n"
     f"UPDATE product_variants SET status='archived' WHERE business_id='{A}' AND id='{G2}';\n"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PG}','gridaxis5',4);\n"
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G2}';\n"
     f"COMMIT;",
     "catalog.variant_axis_set_incomplete")
case("P1-01 and that refusal rolled the whole transaction back: the axis it created is gone and the cell is live",
     f"SELECT 'axis_left=' || count(*)::text FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='gridaxis5';\n"
     f"SELECT 'cell=' || status FROM product_variants WHERE id='{G2}';\n"
     f"SELECT 'axes=' || count(*)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PG}';",
     "axis_left=0\ncell=active\naxes=3", kind="value")
# The committed-state case the challenge asked for: the same predicate as the
# one above section 7b, but evaluated AFTER an un-archive has actually
# happened in this suite. The earlier one measures the state after the
# suite's own writes, and no write in it un-archived anything, which is
# exactly why it could not have caught this door.
case("P1-01 and after an un-archive, no committed LIVE variant of this business is outside its product's grid",
     f"""SELECT count(*)::text FROM product_variants v
          WHERE v.business_id='{A}' AND NOT v.is_base AND v.status <> 'archived'
            AND ( (SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::TEXT[]) FROM jsonb_object_keys(v.attributes) k)
                  IS DISTINCT FROM
                  (SELECT coalesce(array_agg(ma.axis_code ORDER BY ma.axis_code), ARRAY[]::TEXT[])
                     FROM product_matrix_axes ma
                    WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id) );""",
     "0", kind="value")

# ── P1-01's second half: EVERY WRITE PATH THE GRANTS ALLOW ────────────────
# "Prove it with a case that builds the forbidden state through every write
# path the role holds, generated from the grants and not from a hand-written
# list." So the list is read from the CATALOGUE -- `pg_class.relacl` and
# `pg_attribute.attacl` through `aclexplode`, not information_schema, whose
# views filter by enabled role and showed none of the column-scoped grants
# this schema actually carries. Every (grantee, relation, privilege) a
# non-migrator principal holds on the four relations C-APP-01 is written from
# is enumerated, PUBLIC included; the plan below says what this suite does
# with each one, and the coverage case refuses when the catalogue and the
# plan differ in EITHER direction, so a privilege granted later makes this
# suite RED rather than silently uncovered (the "a check must also fail on
# ABSENCE" lesson).
#
# What the enumeration itself found, and it is why the list is generated:
# `daftar_app` holds INSERT, UPDATE and SELECT on `product_variants`. No
# migration grants it by name on any line this author grepped for, and the
# hand-written plan this case started as did not have it -- the role that
# walks through the fourth door was missing from the author's own list of
# write paths.
SWEEP_RELS = "('product_variants','product_matrix_axes','product_attribute_axes','product_attribute_values')"
GRANT_SQL = (
  "SELECT DISTINCT coalesce(r.rolname,'PUBLIC')||'|'||c.relname||'|'||a.privilege_type AS g "
  "  FROM pg_class c, aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee "
  " WHERE c.relnamespace='public'::regnamespace AND c.relname IN " + SWEEP_RELS +
  "   AND coalesce(r.rolname,'PUBLIC') <> 'daftar_migrator' "
  "UNION "
  "SELECT DISTINCT coalesce(r.rolname,'PUBLIC')||'|'||c.relname||'|'||a.privilege_type||'('||att.attname||')' "
  "  FROM pg_class c JOIN pg_attribute att ON att.attrelid=c.oid, aclexplode(att.attacl) a "
  "  LEFT JOIN pg_roles r ON r.oid = a.grantee "
  " WHERE c.relnamespace='public'::regnamespace AND c.relname IN " + SWEEP_RELS +
  "   AND att.attnum > 0 AND NOT att.attisdropped AND coalesce(r.rolname,'PUBLIC') <> 'daftar_migrator' "
  "ORDER BY 1;")
rc_g, out_g, err_g = run(GRANT_SQL)
held = sorted(x.strip() for x in out_g.splitlines() if x.strip())

rls_a_ctx = f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';"
# Each entry: the statement, the string that must appear, and whether it is a
# refusal or an accepted write that cannot reach the forbidden state. A
# privilege that CANNOT reach the state is still exercised -- the write is
# made and then undone in the same case -- because "it cannot reach it" is a
# claim, and an unexercised claim is the kind this phase keeps paying for.
SWEEP = {
 "daftar_app|product_variants|INSERT": (
   f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) VALUES ('{A}','f0000034-0000-0000-0000-000000000034','{PG}','{{\"size\":\"s\"}}'::jsonb,false);",
   "catalog.variant_axis_set_incomplete", "refusal"),
 "daftar_app|product_variants|UPDATE": (
   f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G1}';",
   "deferred grid closure at COMMIT", "refusal"),
 "daftar_app|product_matrix_axes|INSERT": (
   f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PA}','material',3);",
   "catalog.matrix_axis_set_frozen", "refusal"),
 "daftar_app|product_matrix_axes|UPDATE": (
   f"UPDATE product_matrix_axes SET axis_code='material' WHERE business_id='{A}' AND product_id='{PA}' AND axis_code='color';",
   "catalog.matrix_axis_in_use", "refusal"),
 "daftar_app|product_matrix_axes|DELETE": (
   f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PA}' AND axis_code='color';",
   "catalog.matrix_axis_in_use", "refusal"),
 "daftar_app|product_attribute_axes|UPDATE": (
   f"UPDATE product_attribute_axes SET status='archived' WHERE business_id='{A}' AND axis_code='color';",
   "catalog.attribute_axis_in_use", "refusal"),
 "daftar_app|product_attribute_axes|DELETE": (
   f"DELETE FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='color';",
   "foreign key", "refusal"),
 "daftar_app|product_attribute_axes|INSERT": (
   f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','sweep_axis',97);\n"
   f"SELECT 'added=' || count(*)::text FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='sweep_axis';\n"
   f"DELETE FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='sweep_axis';",
   "added=1", "accepted"),
 "daftar_app|product_attribute_values|UPDATE": (
   f"UPDATE product_attribute_values SET status='archived' WHERE business_id='{A}' AND axis_code='color' AND value_code='red';",
   "catalog.attribute_value_in_use", "refusal"),
 "daftar_app|product_attribute_values|DELETE": (
   f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='red';",
   "catalog.attribute_value_in_use", "refusal"),
 "daftar_app|product_attribute_values|INSERT": (
   f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','color','sweepval',96);\n"
   f"SELECT 'added=' || count(*)::text FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='sweepval';\n"
   f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='sweepval';",
   "added=1", "accepted"),
}
# The inventory authority's INSERT on product_variants is COLUMN-scoped and
# cannot name `attributes` at all, and 0053's own authority guard refuses a
# non-base insert from it -- so the cell it would take to reach the forbidden
# state is unwritable twice over. One measured attempt covers every column of
# that grant.
INV_INSERT = (
   f"SET ROLE daftar_inventory_internal;\n"
   f"INSERT INTO product_variants (business_id,id,product_id,is_base) VALUES ('{A}','f0000035-0000-0000-0000-000000000035','{PG}',false);",
   "catalog.base_variant_not_mutable", "refusal")
# A read cannot write the forbidden state, and that is the whole of a SELECT
# entry: it is registered so the coverage comparison SEES it rather than
# filtering it out, which is how a privilege quietly stops being covered.
for k in list(held):
    if "|SELECT" in k:
        SWEEP.setdefault(k, (None, "a read cannot write the forbidden state", "read"))
    elif k.startswith("daftar_inventory_internal|product_variants|INSERT("):
        SWEEP.setdefault(k, INV_INSERT)
case("P1-01 write-path coverage: the plan and the catalogue's grants agree, in both directions",
     "SELECT 'held_not_planned=%s planned_not_held=%s';" % (
        ",".join(sorted(set(held) - set(SWEEP))), ",".join(sorted(set(SWEEP) - set(held)))),
     "held_not_planned= planned_not_held=", kind="value")
_swept=set()
for k in sorted(SWEEP):
    sql, expect, kind_ = SWEEP[k]
    if kind_ == "read":
        continue
    grantee, rel, priv = k.split("|", 2)
    if (grantee, rel, priv.split("(")[0], expect) in _swept:
        continue   # one measured attempt covers every column of one grant
    _swept.add((grantee, rel, priv.split("(")[0], expect))
    case(f"P1-01 sweep {grantee} {priv} on {rel} -> {'refused' if kind_=='refusal' else 'accepted, and cannot reach the state'}",
         sql, expect, role=("daftar_app" if grantee == "daftar_app" else "postgres"),
         pre=rls_a_ctx, kind=("refusal" if kind_ == "refusal" else "value"))
case("P1-01 and after the whole sweep the grid is still closed",
     f"""SELECT count(*)::text FROM product_variants v
          WHERE v.business_id='{A}' AND NOT v.is_base AND v.status <> 'archived'
            AND ( (SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::TEXT[]) FROM jsonb_object_keys(v.attributes) k)
                  IS DISTINCT FROM
                  (SELECT coalesce(array_agg(ma.axis_code ORDER BY ma.axis_code), ARRAY[]::TEXT[])
                     FROM product_matrix_axes ma
                    WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id) );""",
     "0", kind="value")
# The blindness arm of the deferred check, which the install itself cannot
# stage: a principal that holds the write but not the read must get a
# REFUSAL, not a pass. Measured by withdrawing the privilege for the length
# of one case, and the next case asserts it was put back.
# ── P1-01 of the FIFTH round: the blindness arm tested the GRANT ──────────
# The fourth round's arm asked `has_table_privilege`, which is a statement
# about the grant. The condition that defeats a read of these relations is
# VISIBILITY: they carry ENABLE + FORCE RLS and `app_bypass()` is a ROLE test,
# so a principal can hold SELECT on all four and read zero rows. The
# challenger's measurement at 5bad734, in the shape of this pack's own D-32
# proof: run the whole fourth-door chain lawfully in ONE transaction, then drop
# to daftar_app and RESET the context immediately before COMMIT —
#   privileges: true true true true | rows visible: 0 | rc=0 NOT REFUSED
#   live non-base variants outside their product's grid: 1
# The author's own case withdrew a GRANT, and a withdrawn grant and an empty
# read are two different facts. These are the challenger's exact scenario and
# its DELETE sibling, which is the one a read-back cannot answer.
case("P1-01/5 the challenger's scenario: the chain, then daftar_app with the context RESET before COMMIT, is REFUSED",
     f"BEGIN;\n"
     f"UPDATE product_variants SET status='archived' WHERE business_id='{A}' AND product_id='{PG}' AND NOT is_base AND status <> 'archived';\n"
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','blindaxis',92);\n"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PG}','blindaxis',4);\n"
     f"UPDATE product_variants SET status='active' WHERE business_id='{A}' AND id='{G2}';\n"
     f"SET ROLE daftar_app;\n"
     f"RESET app.business_id;\n"
     f"RESET app.tenant_id;\n"
     f"COMMIT;",
     "catalog.matrix_grid_unverifiable")
case("P1-01/5 and that refusal rolled the chain back: the axis is gone and nothing is outside the grid",
     f"SELECT 'axis_left=' || count(*)::text FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='blindaxis';\n"
     f"SELECT 'axes=' || count(*)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PG}';\n"
     f"""SELECT 'outside=' || count(*)::text FROM product_variants v
          WHERE v.business_id='{A}' AND NOT v.is_base AND v.status <> 'archived'
            AND ( (SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::TEXT[]) FROM jsonb_object_keys(v.attributes) k)
                  IS DISTINCT FROM
                  (SELECT coalesce(array_agg(ma.axis_code ORDER BY ma.axis_code), ARRAY[]::TEXT[])
                     FROM product_matrix_axes ma
                    WHERE ma.business_id=v.business_id AND ma.product_id=v.product_id) );""",
     "axis_left=0\naxes=3\noutside=0", kind="value")
# The DELETE sibling, and it is why the read-back cannot be the whole remedy: a
# deleted row is GONE at COMMIT, so "can I read back what I wrote" has no
# answer. The identity comparison gives the same answer for every statement
# kind, and this case is the one that needs it. The refusal rolls the delete
# back, so the fixture product keeps its two axes.
case("P1-01/5 a DELETE committed by a session that is no longer the writing session is REFUSED (the read-back has no answer here)",
     f"BEGIN;\n"
     f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PE}' AND axis_code='color';\n"
     f"SET ROLE daftar_app;\n"
     f"RESET app.business_id;\n"
     f"RESET app.tenant_id;\n"
     f"COMMIT;",
     "catalog.matrix_grid_unverifiable")
case("P1-01/5 and the delete was rolled back: the fixture product keeps both axes",
     f"SELECT 'axes=' || count(*)::text FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PE}';",
     "axes=2", kind="value")
# And the arm is specific, not a blanket refusal of anything unusual: the same
# transaction that keeps its identity commits. A role CHANGE alone is enough to
# refuse, because the row the writer could see is not the row the committer
# can -- which is the whole finding.
case("P1-01/5 the same shape WITHOUT the identity change commits (the arm refuses blindness, not transactions)",
     f"BEGIN;\n"
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','sightedaxis',91);\n"
     f"SELECT 'added=' || count(*)::text FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='sightedaxis';\n"
     f"DELETE FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='sightedaxis';\n"
     f"COMMIT;",
     "added=1", kind="value")
case("P1-01 a principal that cannot read the registries is REFUSED, not passed (catalog.matrix_grid_unverifiable)",
     f"REVOKE SELECT ON product_matrix_axes FROM daftar_app;\n"
     f"SET ROLE daftar_app;\n"
     f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','color','blind',95);\n",
     "catalog.matrix_grid_unverifiable", pre=rls_a_ctx)
case("P1-01 and the privilege that case withdrew is restored, measured rather than assumed",
     f"GRANT SELECT ON product_matrix_axes TO daftar_app;\n"
     f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='blind';\n"
     f"SELECT 'select_restored=' || has_table_privilege('daftar_app','product_matrix_axes','SELECT')::text;",
     "select_restored=true", kind="value")

# ── PA-03 / PA-04. The end-state assertion's own two defects ──────────────
# PA-03: the policy-set pin joined pg_class on `relname` with no namespace
# filter, so a same-named relation in ANOTHER schema contributed its policies
# to the array the pin compares — measured by the challenger as
# `{business_isolation,tenant_membership,zzz_wide}`. It failed closed, so it
# was diagnosability rather than a hole, and it is the same unqualified
# shape fixed for `pg_proc.proname` one round earlier. Every lookup in the
# block is now qualified; this case is the measurement, run the same way.
case("PA-03 a same-named relation in another schema no longer contributes to the policy-set pin",
     "CREATE SCHEMA IF NOT EXISTS chal_other;\n"
     "CREATE TABLE IF NOT EXISTS chal_other.product_matrix_axes (business_id UUID, product_id UUID);\n"
     "ALTER TABLE chal_other.product_matrix_axes ENABLE ROW LEVEL SECURITY;\n"
     "DROP POLICY IF EXISTS zzz_wide ON chal_other.product_matrix_axes;\n"
     "CREATE POLICY zzz_wide ON chal_other.product_matrix_axes USING (true);\n"
     "SELECT 'qualified=' || coalesce(array_to_string((SELECT array_agg(p.polname::TEXT ORDER BY p.polname) "
     "  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
     " WHERE c.relnamespace = 'public'::regnamespace AND c.relname='product_matrix_axes'), ','),'none');\n"
     "SELECT 'unqualified_was=' || coalesce(array_to_string((SELECT array_agg(p.polname::TEXT ORDER BY p.polname) "
     "  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname='product_matrix_axes'), ','),'none');\n"
     "DROP SCHEMA chal_other CASCADE;",
     "qualified=business_isolation,tenant_membership\nunqualified_was=business_isolation,tenant_membership,zzz_wide",
     kind="value")
# PA-04: the tautology list the author asked the challenge to attack, and it
# did: `2 > 1` and `business_id IS NOT NULL` passed four literal spellings.
# The test is now a FUNCTION with three sound forms (the list; evaluation of
# a qualifier that names no column; `col IS NOT NULL` over a NOT NULL
# column), so the proof can call the one implementation the end-state
# assertion calls, with the spellings the challenge measured.
TAUT = "SELECT %s || '=' || catalog_policy_qual_is_tautology('product_matrix_axes','%s')::text;"
case("PA-04 the two spellings the challenge measured through the list are now caught",
     (TAUT % ("'gt'", "(2 > 1)")) + (TAUT % ("'notnull'", "(business_id IS NOT NULL)")),
     "gt=true\nnotnull=true", kind="value")
case("PA-04 and so are the four the list already carried, plus an absent USING clause",
     (TAUT % ("'true'", "true")) + (TAUT % ("'oneone'", "(1 = 1)")) +
     (TAUT % ("'cast'", "true::boolean")) + (TAUT % ("'parens'", "(true)")) +
     "SELECT 'nousing=' || catalog_policy_qual_is_tautology('product_matrix_axes', NULL)::text;",
     "true=true\noneone=true\ncast=true\nparens=true\nnousing=true", kind="value")
# A test that answered `true` to everything would pass the two cases above
# and refuse every correct install, so the other direction is proved too:
# this pack's OWN qualifier, a false arithmetic constant, and `IS NOT NULL`
# over a NULLABLE column of the same relation.
case("PA-04 and it does not call the pack's own tenant qualifier, a false constant, or a nullable column's IS NOT NULL a tautology",
     "SELECT 'own=' || catalog_policy_qual_is_tautology('product_matrix_axes', "
     "  (SELECT pg_get_expr(p.polqual,p.polrelid) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
     "    WHERE c.relnamespace='public'::regnamespace AND c.relname='product_matrix_axes' AND p.polname='tenant_membership'))::text;\n"
     + (TAUT % ("'falseconst'", "(2 < 1)"))
     # Form 3 in both directions on one relation, because every column of
     # this pack's own five relations is NOT NULL and a one-sided
     # demonstration would prove the form only where it answers `true`.
     + "SELECT 'nullable=' || catalog_policy_qual_is_tautology('stock_levels','(avg_unit_cost_base_minor IS NOT NULL)')::text;\n"
     + "SELECT 'notnullable=' || catalog_policy_qual_is_tautology('stock_levels','(on_hand IS NOT NULL)')::text;",
     "own=false\nfalseconst=false\nnullable=false\nnotnullable=true", kind="value")
# ── P2-01 (round 4). Form 4: the column compared with ITSELF ─────────────
# The fourth challenge put fifteen spellings through the function and six
# passed. One of them is not a spelling but a working hole, MEASURED in both
# directions with the policy NAME left intact so the set pin cannot see it:
# `(business_id = business_id)` as tenant_membership's USING and WITH CHECK
# made a cross-tenant read return 6 rows instead of 0 and a cross-tenant
# INSERT return rc=0 instead of rc=3. It is decidable by the premise form 3
# already uses, so it is answered rather than routed.
case("P2-01 the self-comparison the challenge measured as a live cross-tenant hole is caught",
     (TAUT % ("'self'", "(business_id = business_id)"))
     + (TAUT % ("'notdistinct'", "(business_id IS NOT DISTINCT FROM business_id)"))
     + (TAUT % ("'negated'", "(NOT (business_id <> business_id))")),
     "self=true\nnotdistinct=true\nnegated=true", kind="value")
# And the premise is proved rather than assumed, in both directions: over a
# NULLABLE column `(col = col)` is NOT true of every row, so it is not
# called a tautology, while `IS NOT DISTINCT FROM` is true of every row
# including the NULL ones and is caught whatever the column's nullability.
case("P2-01 and form 4 rests on NOT NULL: over a nullable column the self-comparison is not a tautology, but IS NOT DISTINCT FROM still is",
     "SELECT 'nullable_eq=' || catalog_policy_qual_is_tautology('stock_levels','(avg_unit_cost_base_minor = avg_unit_cost_base_minor)')::text;\n"
     "SELECT 'nullable_nd=' || catalog_policy_qual_is_tautology('stock_levels','(avg_unit_cost_base_minor IS NOT DISTINCT FROM avg_unit_cost_base_minor)')::text;\n"
     "SELECT 'notnull_eq=' || catalog_policy_qual_is_tautology('stock_levels','(on_hand = on_hand)')::text;\n"
     "SELECT 'twocols=' || catalog_policy_qual_is_tautology('product_matrix_axes','(business_id = product_id)')::text;",
     "nullable_eq=false\nnullable_nd=true\nnotnull_eq=true\ntwocols=false", kind="value")
# The spellings that still pass, named rather than left for the next round to
# find. They are PR-SEC-P11-01's work: the function is a list of decidable
# forms, not a decision procedure, and this case is the list of what it does
# NOT decide, asserted so the list cannot quietly grow.
case("P2-01 and the spellings that honestly remain are named and measured as still passing (PR-SEC-P11-01)",
     (TAUT % ("'anyarray'", "(business_id = ANY (ARRAY[''00000000-0000-0000-0000-000000000000''::uuid]))"))
     + (TAUT % ("'orself'", "(business_id IS NOT NULL OR business_id IS NULL)"))
     + (TAUT % ("'coalesce'", "(coalesce(business_id, business_id) IS NOT NULL)")),
     "anyarray=false\norself=false\ncoalesce=false", kind="value")
# ── P3-01 (round 4). Form 2 executes the stored expression ───────────────
# The challenge's third finding on this function: form 2 EXECUTEs the
# qualifier to see whether it evaluates to true, so a qualifier with SIDE
# EFFECTS has them, as the INSTALLING principal. Measured with a function
# that writes a row. It is a limit of the form, not a new hole, because the
# input is never user text: it is pg_get_expr of a policy already stored on
# one of this pack's five relations, and the set pin two assertions up means
# the qualifier can only be one the pack installed itself. Recorded as the
# third stated limit of form 2 -- the other two being the installing
# session's settings and a volatile function called once -- and it must be
# revisited if that pin is ever relaxed.
case("P3-01 form 2 evaluates the stored expression, so its side effects happen as the installer (a stated limit, measured)",
     "CREATE SCHEMA IF NOT EXISTS chal_side;\n"
     "CREATE TABLE IF NOT EXISTS chal_side.witness (who TEXT);\n"
     "CREATE OR REPLACE FUNCTION chal_side.touch() RETURNS BOOLEAN LANGUAGE sql VOLATILE AS "
     "$x$ INSERT INTO chal_side.witness VALUES (current_user); SELECT false; $x$;\n"
     "DELETE FROM chal_side.witness;\n"
     "SELECT 'verdict=' || catalog_policy_qual_is_tautology('product_matrix_axes','(chal_side.touch())')::text;\n"
     "SELECT 'side_effect_ran_as=' || coalesce((SELECT who FROM chal_side.witness LIMIT 1),'nobody');\n"
     "DROP SCHEMA chal_side CASCADE;",
     "verdict=false\nside_effect_ran_as=postgres", kind="value")
case("PA-04 and PUBLIC cannot execute the test, which reads the catalogue",
     "SELECT has_function_privilege('public','catalog_policy_qual_is_tautology(text,text)','EXECUTE')::text;",
     "f", kind="value")

# ── P2-N02. An axis a MATRIX registers, archived, freezes that product ────
# The guard's own comment gives this outcome as its reason; it read "in use"
# as "named by a variant" only. Measured at 23a7139: the archive succeeded,
# the product's first variant insert was then refused, and the product could
# not get a variant at all.
case("P2-N02 an axis a product's matrix registers cannot be archived either",
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','freeable',13) ON CONFLICT DO NOTHING;"
     f"UPDATE product_attribute_axes SET status='active' WHERE business_id='{A}' AND axis_code='freeable';"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PE}','freeable',4) ON CONFLICT DO NOTHING;"
     f"UPDATE product_attribute_axes SET status='archived' WHERE business_id='{A}' AND axis_code='freeable';",
     "catalog.attribute_axis_in_use")
case("P2-N02 and once no matrix registers it, archiving the same axis is allowed (a guard, not a blanket refusal)",
     f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PE}' AND axis_code='freeable';"
     f"UPDATE product_attribute_axes SET status='archived' WHERE business_id='{A}' AND axis_code='freeable';"
     f"SELECT status FROM product_attribute_axes WHERE business_id='{A}' AND axis_code='freeable';"
     f"UPDATE product_attribute_axes SET status='active' WHERE business_id='{A}' AND axis_code='freeable';",
     "archived", kind="value")
# P2-06's other half, which is now a STRUCTURAL case and says so. The
# validator's own `catalog.variant_axis_archived` branch was proved live at
# 2da2000 by archiving an axis a matrix registered — the very transition
# P2-N02 now refuses. With both writers of that state refused (an archived
# axis cannot be registered, by the case above; a registered axis cannot be
# archived, by P2-N02), the state is UNREACHABLE from any committed state,
# so the branch cannot be reached by a live case any more. It is kept as
# defence in depth and asserted structurally — stated as a weaker evidence
# class rather than left as a case that passes for a changed reason.
# Finding P3-01 (reported against Pack B at 04d87b3, the same shape here):
# this pin read `pg_get_functiondef`, which INCLUDES the comments, so the
# branch could be deleted from the body and left named in a comment and the
# case would still pass. It reads the comment-stripped `prosrc` now, and it
# matches a RAISE OF that condition rather than a mention of its name. Still
# STRUCTURAL, and still weaker than a behavioural case -- which is why the
# label says so; the state it would refuse is unreachable from any committed
# state, which is the whole reason this is a text pin at all.
case("P2-06 the validator still RAISES its archived-axis refusal, now unreachable from a committed state (defence in depth, STRUCTURAL, comment-stripped)",
     "SELECT (catalog_prosrc_uncommented('public.product_variants_40_matrix_canonical()') "
     "~ 'RAISE\\s+EXCEPTION\\s+''catalog\\.variant_axis_archived')::text;", "t", kind="value")
case("P2-06 and the pin is not vacuous: the stripper answers, and leaves no comment behind for a name to hide in",
     "SELECT (length(catalog_prosrc_uncommented('public.product_variants_40_matrix_canonical()')) > 400)::text "
     "|| ',' || (catalog_prosrc_uncommented('public.product_variants_40_matrix_canonical()') !~ '-- ')::text;",
     "true,true", kind="value")

# P2-07. The guards' absence conclusion, exercised where RLS is LIVE.
# Every case above runs as `postgres`, where row-level security is bypassed
# and the question cannot arise. These two run as `daftar_app`.
rls_a=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';"
case("P2-07 an in-use axis cannot be deleted by the APPLICATION role either (the guard under live RLS)",
     f"DELETE FROM product_matrix_axes WHERE business_id='{A}' AND product_id='{PA}' AND axis_code='color';",
     "catalog.matrix_axis_in_use", role="daftar_app", pre=rls_a)
case("P2-07 nor can it delete an in-use VALUE",
     f"DELETE FROM product_attribute_values WHERE business_id='{A}' AND axis_code='color' AND value_code='red';",
     "catalog.attribute_value_in_use", role="daftar_app", pre=rls_a)
# The challenge recommended making these three guards SECURITY DEFINER. That
# was implemented, measured, and REJECTED: as `daftar_catalog_internal` with
# no session context the definer reads 0 variants where the same read with
# context reads 3, because product_variants carries a RESTRICTIVE
# business_isolation policy that a definer's own USING (true) cannot satisfy
# — so every removal case above reported "no error", including the axis case
# that was green before the change. These two cases pin the answer.
case("P2-07 the guards are SECURITY INVOKER, because a DEFINER one cannot satisfy the restrictive policy",
     # Read through pg_trigger.tgfoid, so the function measured is the one
     # the trigger actually calls and not a same-named function in another
     # schema (the challenger's second note on the end-state assertion).
     "SELECT count(*)::text FROM pg_trigger g JOIN pg_proc pr ON pr.oid=g.tgfoid "
     "WHERE NOT g.tgisinternal AND pr.prosecdef AND g.tgname IN "
     "('product_matrix_axes_10_axis_in_use','product_attribute_values_10_value_in_use',"
     "'product_attribute_axes_10_axis_in_use','product_matrix_axes_30_set_frozen');", "0", kind="value")
# The read is given the privilege it would have had, so what is measured is
# the POLICY and not a missing grant. The challenger's fourth minor finding:
# the GRANT and the REVOKE used to be in two different cases, so a failure
# of the first left the grant behind — a test that can leave a privilege on
# a relation of another phase. Both reads and the REVOKE are now ONE case,
# whose last statement withdraws the grant whatever the reads said, and the
# case asserts afterwards that the grant is gone.
case("P2-07 the measurement itself: that role reads NOTHING without a session context, and WITH one it reads the business's variants",
     "GRANT SELECT ON product_variants TO daftar_catalog_internal;\n"
     "SET ROLE daftar_catalog_internal; SELECT 'no-context=' || count(*)::text FROM product_variants; RESET ROLE;\n"
     f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';\n"
     "SET ROLE daftar_catalog_internal; SELECT 'with-context=' || (count(*) > 0)::text FROM product_variants; RESET ROLE;\n"
     "REVOKE SELECT ON product_variants FROM daftar_catalog_internal;\n"
     "SELECT 'grant_left_behind=' || EXISTS (SELECT 1 FROM information_schema.role_table_grants "
     "WHERE table_name='product_variants' AND grantee='daftar_catalog_internal')::text;",
     "no-context=0\nwith-context=true\ngrant_left_behind=false", kind="value")
case("P2-07 and Pack A leaves product_variants' policy set exactly as it found it",
     "SELECT string_agg(p.polname,',' ORDER BY p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid "
     "WHERE c.relname='product_variants';", "business_isolation,tenant_membership", kind="value")

# 8 RLS, attacked from the application role with another business's context
rls_pre=f"SET app.tenant_id='{TB}'; SET app.business_id='{B}';"
case("as daftar_app in business B, business A's axes are invisible",
     f"SELECT count(*)::text FROM product_attribute_axes WHERE business_id='{A}';",
     "0", role="daftar_app", pre=rls_pre, kind="value")
case("as daftar_app in business B, inserting an axis FOR business A is refused",
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','smuggled',99);",
     "row-level security", role="daftar_app", pre=rls_pre)
case("as daftar_app in business B, business A's matrix rows are invisible",
     f"SELECT count(*)::text FROM product_matrix_axes WHERE business_id='{A}';",
     "0", role="daftar_app", pre=rls_pre, kind="value")
# Six, not the world's two: the sections above register `fit` (archived),
# `material`, `freeable` and now `fabric` in business A — and `cut` is gone,
# because the case that needed it is now the structural one. The number is
# read from the sections that created it rather than from the world file,
# because a case whose expected count silently tracks another section's
# writes is a case that will pass for the wrong reason one day; this one has
# had to be re-derived three times now, which is the cost of that honesty and
# worth paying.
case("with business A's own context the same rows ARE visible (the read is not broken, it is scoped)",
     f"SELECT count(*)::text FROM product_attribute_axes WHERE business_id='{A}';",
     "6", role="daftar_app", pre=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';", kind="value")
case("business A's context with the WRONG tenant sees nothing (tenant_membership, not only business_isolation)",
     f"SELECT count(*)::text FROM product_attribute_axes WHERE business_id='{A}';",
     "0", role="daftar_app", pre=f"SET app.tenant_id='{TB}'; SET app.business_id='{A}';", kind="value")
case("daftar_app does not bypass RLS",
     "SELECT rolbypassrls::text FROM pg_roles WHERE rolname='daftar_app';",
     "f", role="postgres", kind="value")

print(f"{'case':<72} {'verdict':<28} detail")
print("-"*140)
fails=0
for n,v,d in cases:
    if "FAILED" in v: fails+=1
    print(f"{n:<72} {v:<28} {d[:60]}")
print()
print(f"TOTAL {len(cases)} cases, {fails} failed")
sys.exit(1 if fails else 0)
