-- M11. Remove ONLY the write-identity comparison from
-- catalog_grid_closed_check(), keeping the privilege test.
-- This is the fourth round's arm exactly as the fifth round found it: a
-- statement about the GRANT where the defeating condition is VISIBILITY. The
-- fifth round's cases must go red: the privilege test is held in every one of
-- them, and the identity comparison is the only arm that answers at all.
CREATE OR REPLACE FUNCTION catalog_grid_closed_check(p_business UUID, p_product UUID)
RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  r RECORD;
  v_rel TEXT;
BEGIN
  FOREACH v_rel IN ARRAY ARRAY['product_variants','product_matrix_axes',
                               'product_attribute_axes','product_attribute_values'] LOOP
    IF NOT has_table_privilege(v_rel, 'SELECT') THEN
      RAISE EXCEPTION 'catalog.matrix_grid_unverifiable: the grid-closure law cannot read %', v_rel
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  FOR r IN
    SELECT v.id,
           v.attributes,
           jsonb_typeof(v.attributes) AS vtype,
           (SELECT coalesce(array_agg(k ORDER BY k), ARRAY[]::TEXT[])
              FROM jsonb_object_keys(v.attributes) k
             WHERE jsonb_typeof(v.attributes) = 'object')              AS named,
           (SELECT coalesce(array_agg(ma.axis_code ORDER BY ma.axis_code), ARRAY[]::TEXT[])
              FROM product_matrix_axes ma
             WHERE ma.business_id = v.business_id
               AND ma.product_id  = v.product_id)                      AS registered
      FROM product_variants v
     WHERE v.business_id = p_business
       AND v.product_id  = p_product
       AND NOT v.is_base
       AND v.status <> 'archived'
  LOOP
    IF r.named IS DISTINCT FROM r.registered THEN
      RAISE EXCEPTION 'catalog.variant_axis_set_incomplete: live variant % names {%} while its product''s matrix registers {%} [deferred grid closure at COMMIT]',
        r.id, array_to_string(r.named, ','), array_to_string(r.registered, ',')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$fn$;
