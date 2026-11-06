-- Visitor accounts for "My list". Passkey sign-in only: no email, name or password is stored.
-- An account is a random id, its passkeys' public keys, a hashed recovery code and the items it has saved.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,          -- random 128-bit id (also the WebAuthn user handle)
  created_at    TEXT NOT NULL,
  last_seen     TEXT,
  recovery_hash TEXT UNIQUE,               -- SHA-256 of the one-time recovery code (128-bit random); null once used until a new one is made
  session_gen   INTEGER NOT NULL DEFAULT 0, -- bumping it signs the account out everywhere
  list_seen_at  TEXT                       -- when the person last opened My list: drives the "new" badges
);

CREATE TABLE IF NOT EXISTS passkeys (
  id          TEXT PRIMARY KEY,            -- credential id, base64url
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  jwk         TEXT NOT NULL,               -- public key only
  alg         INTEGER NOT NULL,
  sign_count  INTEGER NOT NULL DEFAULT 0,
  backed_up   INTEGER NOT NULL DEFAULT 0,  -- synced passkey (iCloud, Google, password manager)
  label       TEXT,
  created_at  TEXT NOT NULL,
  last_used   TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_account ON passkeys(account_id);

-- Single-use, 5-minute ceremony challenges. Looked up by the challenge itself and deleted on use.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL,               -- register | add | login
  account_id  TEXT,                        -- register: the new account's id; add: the signed-in account
  expires     INTEGER NOT NULL             -- epoch ms
);

CREATE TABLE IF NOT EXISTS favourites (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
