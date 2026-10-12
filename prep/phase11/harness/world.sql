\set ON_ERROR_STOP on
BEGIN;
-- Two tenants, two businesses: the second exists so cross-business and
-- cross-tenant isolation can be attacked rather than assumed.
INSERT INTO tenants (id) VALUES ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');
INSERT INTO businesses (id, tenant_id, name, store_slug, country_code, base_currency, industry_profile_key, default_locale, enabled_locales, status, timezone, storefront_locale)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','Biz A','biz-a','PS','ILS','retail','ar','{ar,en,tr}','active','Asia/Hebron','ar'),
       ('bbbbbbbb-0000-0000-0000-00000000000b','22222222-2222-2222-2222-222222222222','Biz B','biz-b','JO','JOD','retail','ar','{ar,en}','active','Asia/Amman','ar');
-- Untracked on insert: products_10_inventory_config_authority refuses
-- track_inventory from any principal but the inventory configuration
-- command's owner. A real finding about the test's own shape, not about the
-- pack: the matrix proofs need no stock, and the one proof that does
-- (variant_matrix_locked) gets its stock_levels row as the internal owner.
INSERT INTO products (business_id, id, sku, status, base_price_minor, price_currency)
VALUES ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000d','TSHIRT','active',0,'ILS'),
       -- A SECOND apparel product in business A with the same 2-axis matrix
       -- and NO variants. It exists because finding P1-N01's fix freezes the
       -- axis set of a POPULATED matrix, so every case about the matrix
       -- lifecycle itself (an archived axis cannot be registered; an axis
       -- registered by a matrix cannot be archived; an axis set may still be
       -- extended while nothing is addressed by it) needs a product whose
       -- grid is still empty. Running those on TSHIRT would have them refused
       -- by the freeze guard instead of by the guard under test — a
       -- constraint that fires first hiding the one being proved, which this
       -- phase has paid for twice.
       ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000e','TSHIRT-EMPTY','active',0,'ILS'),
       ('bbbbbbbb-0000-0000-0000-00000000000b','eeeeeeee-0000-0000-0000-00000000000e','ABAYA','active',0,'JOD');
INSERT INTO product_translations (business_id, product_id, locale, name) VALUES
 ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000d','ar','تي شيرت'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000e','ar','تي شيرت فارغ'),
 ('bbbbbbbb-0000-0000-0000-00000000000b','eeeeeeee-0000-0000-0000-00000000000e','ar','عباية');
-- Pack A world: two axes, three sizes, two colours, a 2-axis matrix.
INSERT INTO product_attribute_axes (business_id, axis_code, sort_order) VALUES
 ('aaaaaaaa-0000-0000-0000-00000000000a','size',1),('aaaaaaaa-0000-0000-0000-00000000000a','color',2),
 ('bbbbbbbb-0000-0000-0000-00000000000b','size',1);
INSERT INTO product_attribute_axis_translations (business_id, axis_code, locale, name) VALUES
 ('aaaaaaaa-0000-0000-0000-00000000000a','size','ar','المقاس'),('aaaaaaaa-0000-0000-0000-00000000000a','size','en','Size'),('aaaaaaaa-0000-0000-0000-00000000000a','size','tr','Beden'),
 ('aaaaaaaa-0000-0000-0000-00000000000a','color','ar','اللون'),('aaaaaaaa-0000-0000-0000-00000000000a','color','en','Colour'),('aaaaaaaa-0000-0000-0000-00000000000a','color','tr','Renk');
INSERT INTO product_attribute_values (business_id, axis_code, value_code, sort_order) VALUES
 ('aaaaaaaa-0000-0000-0000-00000000000a','size','s',1),('aaaaaaaa-0000-0000-0000-00000000000a','size','m',2),('aaaaaaaa-0000-0000-0000-00000000000a','size','l',3),
 ('aaaaaaaa-0000-0000-0000-00000000000a','color','red',1),('aaaaaaaa-0000-0000-0000-00000000000a','color','blue',2),
 ('aaaaaaaa-0000-0000-0000-00000000000a','size','xl_archived',4);
UPDATE product_attribute_values SET status='archived' WHERE business_id='aaaaaaaa-0000-0000-0000-00000000000a' AND axis_code='size' AND value_code='xl_archived';
INSERT INTO product_matrix_axes (business_id, product_id, axis_code, axis_position) VALUES
 ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000d','size',1),
 ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000d','color',2),
 ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000e','size',1),
 ('aaaaaaaa-0000-0000-0000-00000000000a','dddddddd-0000-0000-0000-00000000000e','color',2);
COMMIT;
SELECT 'WORLD BUILT' AS step;
