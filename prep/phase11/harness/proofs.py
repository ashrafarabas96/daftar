import subprocess, sys, json
SOCK="/var/tmp/p11s/run"; PORT="55511"; DB="daftar"
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
case("with business A's own context the same rows ARE visible (the read is not broken, it is scoped)",
     f"SELECT count(*)::text FROM product_attribute_axes WHERE business_id='{A}';",
     "2", role="daftar_app", pre=f"SET app.tenant_id='{TA}'; SET app.business_id='{A}';", kind="value")
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
