-- 0003 — tenancy: tenant + business isolation by construction (composite FKs everywhere)
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  store_slug TEXT NOT NULL UNIQUE CHECK (store_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  base_currency TEXT NOT NULL REFERENCES currencies(code),
  industry_profile_key TEXT NOT NULL DEFAULT 'generic' CHECK (industry_profile_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  default_locale TEXT NOT NULL DEFAULT 'ar' CHECK (default_locale IN ('ar','en','tr')),
  enabled_locales TEXT[] NOT NULL DEFAULT '{ar}' CHECK (enabled_locales <@ ARRAY['ar','en','tr']::text[] AND array_length(enabled_locales,1) >= 1),
  financial_started_at TIMESTAMPTZ,      -- NULL until first financial tx (Phase 2+); locks base currency
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roles: system roles (owner) immutable + non-creatable via app role (0006 trigger)
CREATE TABLE business_roles (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  key TEXT NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  is_system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, key)
);

CREATE TABLE role_permissions (
  business_id UUID NOT NULL,
  role_id UUID NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (business_id, role_id, permission),
  FOREIGN KEY (business_id, role_id) REFERENCES business_roles(business_id, id) ON DELETE CASCADE
);

-- Membership: user ↔ business with a role. Composite FK ties membership to the
-- SAME business as the role (no cross-business role assignment).
CREATE TABLE memberships (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id),
  FOREIGN KEY (business_id, role_id) REFERENCES business_roles(business_id, id)
);

CREATE TABLE branches (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id)
);
CREATE UNIQUE INDEX branches_one_default ON branches (business_id) WHERE is_default;

CREATE TABLE warehouses (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  is_default BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  -- Composite FK: warehouse's branch MUST belong to the same business.
  FOREIGN KEY (business_id, branch_id) REFERENCES branches(business_id, id)
);
CREATE UNIQUE INDEX warehouses_one_default ON warehouses (business_id) WHERE is_default;
