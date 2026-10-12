-- M8. Drop the per-verb BEFORE guards and KEEP the deferred grid-closure
-- check. The other half of the pair-drop: the statements each of these
-- refused are now permitted individually, and what refuses the ones that
-- reach the forbidden state is the COMMIT. A case that stays green here is
-- a case the deferred check answers; a case that goes red is one only the
-- statement-level guard could answer (a value archived with no variant yet
-- naming it, an axis removed from a matrix that has none).
DROP TRIGGER product_matrix_axes_10_axis_in_use       ON product_matrix_axes;
DROP TRIGGER product_attribute_values_10_value_in_use ON product_attribute_values;
DROP TRIGGER product_attribute_axes_10_axis_in_use    ON product_attribute_axes;
DROP TRIGGER product_matrix_axes_30_set_frozen        ON product_matrix_axes;
