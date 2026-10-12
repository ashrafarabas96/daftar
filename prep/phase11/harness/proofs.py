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

V=lambda vid,attrs,base='false': f"INSERT INTO product_variants (business_id,id,product_id,attributes,is_base) VALUES ('{A}','{vid}','{PA}','{attrs}'::jsonb,{base});"

# 1 happy path, and WHERE the canonical form actually comes from
case("happy path: a registered combination is accepted",
     V('f0000001-0000-0000-0000-000000000001','{"size":"s","color":"red"}')+
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
     f"INSERT INTO product_variants (business_id,id,product_id,attributes) VALUES ('{B}','f0000010-0000-0000-0000-000000000010','eeeeeeee-0000-0000-0000-00000000000e','{{}}'::jsonb);"
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
# archivable, which is the lifecycle the registry exists for.
case("a value no variant names is still archivable (the guard refuses removal, not administration)",
     f"UPDATE product_attribute_values SET status='archived' WHERE business_id='{A}' AND axis_code='size' AND value_code='l';"
     f"SELECT status FROM product_attribute_values WHERE business_id='{A}' AND axis_code='size' AND value_code='l';",
     "archived", kind="value")
case("and un-archiving it is not a removal either",
     f"UPDATE product_attribute_values SET status='active' WHERE business_id='{A}' AND axis_code='size' AND value_code='l';"
     f"SELECT status FROM product_attribute_values WHERE business_id='{A}' AND axis_code='size' AND value_code='l';",
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
case("P2-06 an ARCHIVED axis cannot be added to a product's matrix",
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order,status) VALUES ('{A}','fit',9,'archived');"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PA}','fit',3);",
     "catalog.variant_axis_archived")
case("P2-06 nor can a variant name an archived axis, even one its matrix registers",
     # The axis is archived while nothing names it (which the guard allows),
     # the matrix row is created first, and only then is the variant tried:
     # otherwise the matrix guard refuses first and the validator's own read
     # is never reached. A constraint that fires first hides the one under
     # test — this phase has paid for that lesson once already.
     f"INSERT INTO product_attribute_axes (business_id,axis_code,sort_order) VALUES ('{A}','cut',10);"
     f"INSERT INTO product_matrix_axes (business_id,product_id,axis_code,axis_position) VALUES ('{A}','{PA}','cut',3);"
     f"INSERT INTO product_attribute_values (business_id,axis_code,value_code,sort_order) VALUES ('{A}','cut','slim',1);"
     f"UPDATE product_attribute_axes SET status='archived' WHERE business_id='{A}' AND axis_code='cut';"
     + V('f0000011-0000-0000-0000-000000000011','{"size":"s","color":"blue","cut":"slim"}'),
     "catalog.variant_axis_archived")

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
     "SELECT count(*)::text FROM pg_proc WHERE proname IN "
     "('product_matrix_axes_10_axis_in_use','product_attribute_values_10_value_in_use','product_attribute_axes_10_axis_in_use') "
     "AND prosecdef;", "0", kind="value")
# The read is given the privilege it would have had, so what is measured is
# the POLICY and not a missing grant; the grant is withdrawn in the second
# case, so the database ends as the pack left it.
case("P2-07 the measurement itself: that role reads NOTHING without a session context",
     "SET ROLE daftar_catalog_internal; SELECT count(*)::text FROM product_variants; RESET ROLE;",
     "0", pre="GRANT SELECT ON product_variants TO daftar_catalog_internal;", kind="value")
case("P2-07 and the same read WITH a context sees the business's variants, so it is the policy and not the grant",
     "SET ROLE daftar_catalog_internal; SELECT (count(*) > 0)::text FROM product_variants; RESET ROLE;"
     " REVOKE SELECT ON product_variants FROM daftar_catalog_internal;",
     "t", pre=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';", kind="value")
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
# Four, not the world's two: the removal-direction section above registers
# `fit` (archived) and `cut` in business A. The number is read from the
# section that created it rather than from the world file, because a case
# whose expected count silently tracks another section's writes is a case
# that will pass for the wrong reason one day.
case("with business A's own context the same rows ARE visible (the read is not broken, it is scoped)",
     f"SELECT count(*)::text FROM product_attribute_axes WHERE business_id='{A}';",
     "4", role="daftar_app", pre=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';", kind="value")
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
