-- M7. Drop ONLY the deferred grid-closure check (finding P1-01, round 4),
-- leaving every per-verb BEFORE guard in place. The fourth door
-- (un-archiving a stale cell onto a grown grid) is watched by nothing else,
-- so the P1-01 cases must go red while the per-verb cases stay green.
DROP TRIGGER product_variants_90_grid_closed          ON product_variants;
DROP TRIGGER product_matrix_axes_90_grid_closed       ON product_matrix_axes;
DROP TRIGGER product_attribute_axes_90_grid_closed    ON product_attribute_axes;
DROP TRIGGER product_attribute_values_90_grid_closed  ON product_attribute_values;
