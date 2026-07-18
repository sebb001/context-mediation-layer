export const CORE_SCHEMA_SQL = String.raw`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS scopes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS domains (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    scope          TEXT NOT NULL DEFAULT 'default',
    name           TEXT NOT NULL,
    concern        TEXT NOT NULL,
    notion_page_id TEXT,
    UNIQUE(scope, name),
    FOREIGN KEY (scope) REFERENCES scopes(name)
);

CREATE TABLE IF NOT EXISTS actors (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT NOT NULL UNIQUE,
    role                  TEXT NOT NULL CHECK (role IN ('human', 'agent')),
    provider              TEXT NOT NULL,
    actor_type            TEXT,
    capability_namespace  TEXT NOT NULL,
    session_id            TEXT,
    default_scope         TEXT NOT NULL DEFAULT 'default',
    status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
    contract_key          TEXT,
    default_contract_key  TEXT,
    contract_ref          TEXT,
    context_ref           TEXT,
    context_policy        TEXT,
    description           TEXT,
    created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (default_scope) REFERENCES scopes(name)
);

CREATE TABLE IF NOT EXISTS roles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
    contract_key TEXT,
    contract_ref TEXT,
    context_ref  TEXT,
    policy_ref   TEXT,
    description  TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS contracts (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    key                TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('root', 'system', 'role', 'actor', 'actor_type', 'skill', 'policy', 'process')),
    scope              TEXT NOT NULL DEFAULT 'default',
    domain_id          INTEGER,
    parent_key         TEXT,
    title              TEXT NOT NULL,
    body               TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'superseded', 'retired')),
    version            INTEGER NOT NULL DEFAULT 1,
    custodian_actor_id INTEGER NOT NULL,
    governing_contract_key TEXT,
    mandate_ref        TEXT,
    content_hash       TEXT NOT NULL,
    supersedes         INTEGER,
    superseded_by      INTEGER,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(key, version),
    FOREIGN KEY (scope) REFERENCES scopes(name),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (custodian_actor_id) REFERENCES actors(id),
    FOREIGN KEY (supersedes) REFERENCES contracts(id),
    FOREIGN KEY (superseded_by) REFERENCES contracts(id)
);

CREATE TABLE IF NOT EXISTS actor_role_bindings (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id       INTEGER NOT NULL,
    role_id        INTEGER NOT NULL,
    surface        TEXT NOT NULL,
    provider       TEXT NOT NULL,
    credential_ref TEXT,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'retired')),
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(actor_id, role_id, surface, credential_ref),
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS actor_sessions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id       INTEGER NOT NULL,
    session_ref    TEXT NOT NULL,
    surface        TEXT NOT NULL,
    provider       TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    transcript_ref TEXT,
    started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    ended_at       TEXT,
    UNIQUE(actor_id, session_ref),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS intents (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    scope            TEXT NOT NULL DEFAULT 'default',
    description      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed', 'superseded')),
    version          INTEGER NOT NULL DEFAULT 1,
    source           TEXT NOT NULL,
    addressed_to     INTEGER,
    parent_id        INTEGER,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    resolution_notes TEXT,
    FOREIGN KEY (scope) REFERENCES scopes(name),
    FOREIGN KEY (addressed_to) REFERENCES actors(id),
    FOREIGN KEY (parent_id) REFERENCES intents(id)
);

CREATE TABLE IF NOT EXISTS interpretations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id        INTEGER NOT NULL,
    domain_id        INTEGER NOT NULL,
    actor_id         INTEGER NOT NULL,
    title            TEXT NOT NULL,
    scope_assumption TEXT,
    alignment        TEXT NOT NULL DEFAULT 'uncertain' CHECK (alignment IN ('aligned', 'uncertain', 'divergent', 'superseded')),
    status           TEXT NOT NULL DEFAULT 'clarifying' CHECK (status IN ('fyi', 'clarifying', 'proposed', 'flagged', 'superseded')),
    resolver_id      INTEGER,
    resolve_by       TEXT,
    superseded_by    INTEGER,
    source_ref       TEXT,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (intent_id) REFERENCES intents(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (resolver_id) REFERENCES actors(id),
    FOREIGN KEY (superseded_by) REFERENCES interpretations(id)
);

CREATE TABLE IF NOT EXISTS actions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id         INTEGER NOT NULL,
    interpretation_id INTEGER,
    actor_id          INTEGER NOT NULL,
    domain_id         INTEGER,
    governing_contract_key TEXT,
    assumed_role      TEXT,
    invoked_skill_ref TEXT,
    policy_ref        TEXT,
    description       TEXT NOT NULL,
    outcome           TEXT,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (intent_id) REFERENCES intents(id),
    FOREIGN KEY (interpretation_id) REFERENCES interpretations(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id)
);

CREATE TABLE IF NOT EXISTS expertise_signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    intent_id  INTEGER NOT NULL,
    domain_id  INTEGER NOT NULL,
    actor_id   INTEGER NOT NULL,
    signal     TEXT NOT NULL CHECK (signal IN ('concerned', 'not_concerned', 'blocked')),
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (intent_id) REFERENCES intents(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS watermarks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id     INTEGER NOT NULL,
    table_name   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(actor_id, table_name),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope        TEXT NOT NULL,
    event_type   TEXT NOT NULL,
    entity_table TEXT NOT NULL,
    entity_id    INTEGER NOT NULL,
    actor_id     INTEGER NOT NULL,
    reason       TEXT,
    snapshot     TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS claims (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_table TEXT NOT NULL,
    entity_id    INTEGER NOT NULL,
    actor_id     INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    released_at  TEXT,
    FOREIGN KEY (actor_id) REFERENCES actors(id)
);

CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scope       TEXT NOT NULL DEFAULT 'default',
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    summary     TEXT NOT NULL,
    body_ref    TEXT,
    actor_id    INTEGER NOT NULL,
    assumed_role      TEXT,
    invoked_skill_ref TEXT,
    policy_ref        TEXT,
    domain_id   INTEGER,
    intent_id   INTEGER,
    source_ref  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    FOREIGN KEY (scope) REFERENCES scopes(name),
    FOREIGN KEY (actor_id) REFERENCES actors(id),
    FOREIGN KEY (domain_id) REFERENCES domains(id),
    FOREIGN KEY (intent_id) REFERENCES intents(id)
);

CREATE INDEX IF NOT EXISTS idx_intents_scope_status ON intents(scope, status);
CREATE INDEX IF NOT EXISTS idx_intents_addressed_to ON intents(addressed_to);
CREATE INDEX IF NOT EXISTS idx_intents_parent ON intents(parent_id);
CREATE INDEX IF NOT EXISTS idx_reports_scope_kind ON reports(scope, kind);
CREATE INDEX IF NOT EXISTS idx_reports_intent ON reports(intent_id);
CREATE INDEX IF NOT EXISTS idx_reports_actor ON reports(actor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_open_key ON contracts(key) WHERE status IN ('draft', 'active');
CREATE INDEX IF NOT EXISTS idx_contracts_kind_status ON contracts(kind, status);
CREATE INDEX IF NOT EXISTS idx_contracts_scope_status ON contracts(scope, status);
CREATE INDEX IF NOT EXISTS idx_contracts_domain_status ON contracts(domain_id, status);
CREATE INDEX IF NOT EXISTS idx_contracts_parent ON contracts(parent_key, status);
CREATE INDEX IF NOT EXISTS idx_actor_role_bindings_actor ON actor_role_bindings(actor_id, status);
CREATE INDEX IF NOT EXISTS idx_actor_role_bindings_role ON actor_role_bindings(role_id, status);
CREATE INDEX IF NOT EXISTS idx_actor_sessions_actor_status ON actor_sessions(actor_id, status);
CREATE INDEX IF NOT EXISTS idx_actor_sessions_ref ON actor_sessions(session_ref);
CREATE INDEX IF NOT EXISTS idx_interpretations_intent ON interpretations(intent_id);
CREATE INDEX IF NOT EXISTS idx_interpretations_actor ON interpretations(actor_id);
CREATE INDEX IF NOT EXISTS idx_interpretations_domain ON interpretations(domain_id);
CREATE INDEX IF NOT EXISTS idx_actions_intent ON actions(intent_id);
CREATE INDEX IF NOT EXISTS idx_actions_actor ON actions(actor_id);
CREATE INDEX IF NOT EXISTS idx_actions_domain ON actions(domain_id);
CREATE INDEX IF NOT EXISTS idx_actions_governing_contract ON actions(governing_contract_key);
CREATE INDEX IF NOT EXISTS idx_expertise_intent ON expertise_signals(intent_id);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_table, entity_id);
CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_claims_entity ON claims(entity_table, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_claims_actor ON claims(actor_id, status);
`;
