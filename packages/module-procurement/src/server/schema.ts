import type { ModuleMigration } from '@platform/contracts';

/**
 * Procurement tables. They share the physical SQLite file with the platform but
 * are created, migrated and written only by this module — the platform has no
 * statement anywhere that names a `pc_` table.
 *
 * The only cross-boundary reference is `pc_attachments.file_id`, which points at
 * the platform's managed file store. It is intentionally *not* a foreign key:
 * the platform owns that row's lifetime and this module must not constrain it.
 */
export const PROCUREMENT_MIGRATIONS: ModuleMigration[] = [
  {
    id: 'procurement-0001-init',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS pc_cases (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        code        TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        currency    TEXT NOT NULL,
        price_basis TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'collecting',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_cases_code ON pc_cases(owner_id, code);

      CREATE TABLE IF NOT EXISTS pc_suppliers (
        id            TEXT PRIMARY KEY,
        owner_id      TEXT NOT NULL,
        name          TEXT NOT NULL,
        tax_id        TEXT,
        country       TEXT NOT NULL DEFAULT 'PL',
        contact_email TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pc_suppliers_owner ON pc_suppliers(owner_id, name);

      CREATE TABLE IF NOT EXISTS pc_requirements (
        id             TEXT PRIMARY KEY,
        case_id        TEXT NOT NULL REFERENCES pc_cases(id) ON DELETE CASCADE,
        position       INTEGER NOT NULL,
        name           TEXT NOT NULL,
        sku            TEXT,
        unit           TEXT NOT NULL,
        quantity_milli INTEGER NOT NULL,
        spec           TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_pc_req_case ON pc_requirements(case_id, position);

      CREATE TABLE IF NOT EXISTS pc_offers (
        id             TEXT PRIMARY KEY,
        case_id        TEXT NOT NULL REFERENCES pc_cases(id) ON DELETE CASCADE,
        supplier_id    TEXT NOT NULL REFERENCES pc_suppliers(id) ON DELETE RESTRICT,
        reference      TEXT NOT NULL,
        received_at    TEXT NOT NULL,
        currency       TEXT NOT NULL,
        price_basis    TEXT NOT NULL,
        valid_until    TEXT,
        delivery_days  INTEGER,
        delivery_terms TEXT,
        notes          TEXT,
        version        INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pc_offers_case ON pc_offers(case_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_offers_ref ON pc_offers(case_id, supplier_id, reference);

      CREATE TABLE IF NOT EXISTS pc_offer_items (
        id               TEXT PRIMARY KEY,
        offer_id         TEXT NOT NULL REFERENCES pc_offers(id) ON DELETE CASCADE,
        requirement_id   TEXT REFERENCES pc_requirements(id) ON DELETE SET NULL,
        position         INTEGER NOT NULL,
        name             TEXT NOT NULL,
        unit             TEXT NOT NULL,
        quantity_milli   INTEGER NOT NULL,
        unit_price_minor INTEGER,
        note             TEXT,
        version          INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_pc_items_offer ON pc_offer_items(offer_id, position);

      CREATE TABLE IF NOT EXISTS pc_attachments (
        id         TEXT PRIMARY KEY,
        offer_id   TEXT NOT NULL REFERENCES pc_offers(id) ON DELETE CASCADE,
        file_id    TEXT NOT NULL,
        kind       TEXT NOT NULL DEFAULT 'offer_document',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pc_attach_offer ON pc_attachments(offer_id);

      CREATE TABLE IF NOT EXISTS pc_provenance (
        id            TEXT PRIMARY KEY,
        offer_id      TEXT NOT NULL REFERENCES pc_offers(id) ON DELETE CASCADE,
        offer_item_id TEXT REFERENCES pc_offer_items(id) ON DELETE CASCADE,
        field         TEXT NOT NULL,
        file_id       TEXT NOT NULL,
        locator       TEXT NOT NULL,
        note          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pc_prov_item ON pc_provenance(offer_item_id);
      CREATE INDEX IF NOT EXISTS idx_pc_prov_offer ON pc_provenance(offer_id);

      CREATE TABLE IF NOT EXISTS pc_criteria (
        id        TEXT PRIMARY KEY,
        case_id   TEXT NOT NULL REFERENCES pc_cases(id) ON DELETE CASCADE,
        key       TEXT NOT NULL,
        label     TEXT NOT NULL,
        weight    INTEGER NOT NULL,
        direction TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pc_criteria_case_key ON pc_criteria(case_id, key);
    `,
  },
];
