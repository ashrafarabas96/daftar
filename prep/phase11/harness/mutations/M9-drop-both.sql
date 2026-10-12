-- M9. Both layers gone. Nothing holds C-APP-01, so every door of it is open
-- at once — which is the only run that shows the laws are not being held by
-- something else in the schema.
DROP TRIGGER product_variants_90_grid_closed          ON product_variants;
DROP TRIGGER product_matrix_axes_90_grid_closed       ON product_matrix_axes;
DROP TRIGGER product_attribute_axes_90_grid_closed    ON product_attribute_axes;
DROP TRIGGER product_attribute_values_90_grid_closed  ON product_attribute_values;
DROP TRIGGER product_matrix_axes_10_axis_in_use       ON product_matrix_axes;
DROP TRIGGER product_attribute_values_10_value_in_use ON product_attribute_values;
DROP TRIGGER product_attribute_axes_10_axis_in_use    ON product_attribute_axes;
DROP TRIGGER product_matrix_axes_30_set_frozen        ON product_matrix_axes;
