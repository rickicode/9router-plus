/**
 * Connection matching service with O(1) lookup performance
 *
 * Strategies (in order):
 *   1. Source ID — exact match by id from backup payload (provider+authType
 *      must agree, processed connections excluded).
 *   2. OAuth email — provider+email lookup for OAuth records.
 *   3. Name      — provider+authType+name lookup. byName uses an *array*
 *      so name collisions don't silently overwrite each other.
 *   4. Single-OAuth fallback — only fires for OAuth records that have NO
 *      identity at all (no email, no name). This prevents records that are
 *      meant to become NEW connections (because they carry their own unique
 *      email/name) from accidentally overwriting an existing connection just
 *      because the provider has exactly one unprocessed OAuth account.
 *   5. Token fingerprint — for OAuth records without identity, fall back to
 *      matching by accessToken/refreshToken/idToken/projectId so the same
 *      backup re-imported is treated as an update instead of a duplicate.
 */

const TOKEN_FINGERPRINT_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "apiKey",
  "projectId",
];

function pickTokenFingerprint(record) {
  if (!record || typeof record !== "object") return null;
  for (const field of TOKEN_FINGERPRINT_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      return `${field}:${value}`;
    }
  }
  return null;
}

export class ConnectionMatcher {
  constructor(connections) {
    this.byId = new Map();
    this.byEmail = new Map();
    this.byName = new Map(); // Map<key, Connection[]>
    this.byProvider = new Map();
    this.byTokenFingerprint = new Map(); // Map<provider:fingerprint, Connection>
    this.processedIds = new Set();

    for (const conn of connections) {
      this._indexConnection(conn);
    }
  }

  _indexConnection(conn) {
    if (!conn || typeof conn !== "object" || !conn.id) return;

    this.byId.set(conn.id, conn);

    if (conn.authType === "oauth" && conn.email) {
      const key = `${conn.provider}:${conn.email}`;
      this.byEmail.set(key, conn);
    }

    if (conn.name) {
      const key = `${conn.provider}:${conn.authType}:${conn.name}`;
      const existing = this.byName.get(key);
      if (Array.isArray(existing)) {
        existing.push(conn);
      } else {
        this.byName.set(key, [conn]);
      }
    }

    if (!this.byProvider.has(conn.provider)) {
      this.byProvider.set(conn.provider, []);
    }
    this.byProvider.get(conn.provider).push(conn);

    const fingerprint = pickTokenFingerprint(conn);
    if (fingerprint) {
      this.byTokenFingerprint.set(`${conn.provider}:${fingerprint}`, conn);
    }
  }

  _firstUnprocessedFromList(list) {
    if (!Array.isArray(list)) return null;
    for (const conn of list) {
      if (conn && !this.processedIds.has(conn.id)) {
        return conn;
      }
    }
    return null;
  }

  findMatch(record, sourceId) {
    // Strategy 1: Match by source ID (exact match from backup)
    if (sourceId) {
      const conn = this.byId.get(sourceId);
      if (
        conn &&
        conn.provider === record.provider &&
        conn.authType === record.authType &&
        !this.processedIds.has(conn.id)
      ) {
        return conn;
      }
    }

    // Strategy 2: Match OAuth by email (unique identifier)
    if (record.authType === "oauth" && record.email) {
      const key = `${record.provider}:${record.email}`;
      const conn = this.byEmail.get(key);
      if (conn && !this.processedIds.has(conn.id)) {
        return conn;
      }
    }

    // Strategy 3: Match by name (for API keys or named connections)
    if (record.name) {
      const key = `${record.provider}:${record.authType}:${record.name}`;
      const matched = this._firstUnprocessedFromList(this.byName.get(key));
      if (matched) return matched;
    }

    // Strategy 4: Single OAuth fallback — ONLY for records lacking identity.
    // Records that carry their own email/name should always create a new
    // connection rather than collapse into an existing one.
    if (record.authType === "oauth" && !record.email && !record.name) {
      const providerConns = this.byProvider.get(record.provider) || [];
      const unprocessed = providerConns.filter(
        (c) => c.authType === "oauth" && !this.processedIds.has(c.id),
      );
      if (unprocessed.length === 1) {
        return unprocessed[0];
      }
    }

    // Strategy 5: Token fingerprint fallback for OAuth without identity.
    // Re-importing the same backup should update existing rather than create
    // duplicates.
    if (record.authType === "oauth" && !record.email && !record.name) {
      const fingerprint = pickTokenFingerprint(record);
      if (fingerprint) {
        const key = `${record.provider}:${fingerprint}`;
        const conn = this.byTokenFingerprint.get(key);
        if (conn && !this.processedIds.has(conn.id)) {
          return conn;
        }
      }
    }

    return null;
  }

  markProcessed(connectionId) {
    this.processedIds.add(connectionId);
  }

  addConnection(connection) {
    this._indexConnection(connection);
  }

  updateConnection(connectionId, updates) {
    const conn = this.byId.get(connectionId);
    if (!conn) return;

    const oldProvider = conn.provider;
    const oldEmail = conn.email;
    const oldName = conn.name;
    const oldFingerprint = pickTokenFingerprint(conn);

    // Remove old indexes before updating
    if (conn.authType === "oauth" && oldEmail) {
      const oldKey = `${oldProvider}:${oldEmail}`;
      if (this.byEmail.get(oldKey) === conn) {
        this.byEmail.delete(oldKey);
      }
    }
    if (oldName) {
      const oldKey = `${oldProvider}:${conn.authType}:${oldName}`;
      const list = this.byName.get(oldKey);
      if (Array.isArray(list)) {
        const idx = list.indexOf(conn);
        if (idx !== -1) list.splice(idx, 1);
        if (list.length === 0) this.byName.delete(oldKey);
      }
    }
    if (oldFingerprint) {
      const oldKey = `${oldProvider}:${oldFingerprint}`;
      if (this.byTokenFingerprint.get(oldKey) === conn) {
        this.byTokenFingerprint.delete(oldKey);
      }
    }

    // Apply updates
    Object.assign(conn, updates);

    // If provider changed, move to new provider array
    if (updates.provider && updates.provider !== oldProvider) {
      const oldArray = this.byProvider.get(oldProvider) || [];
      const index = oldArray.findIndex((c) => c.id === connectionId);
      if (index !== -1) oldArray.splice(index, 1);

      if (!this.byProvider.has(conn.provider)) {
        this.byProvider.set(conn.provider, []);
      }
      this.byProvider.get(conn.provider).push(conn);
    }

    // Rebuild indexes with new values
    if (conn.authType === "oauth" && conn.email) {
      const newKey = `${conn.provider}:${conn.email}`;
      this.byEmail.set(newKey, conn);
    }
    if (conn.name) {
      const newKey = `${conn.provider}:${conn.authType}:${conn.name}`;
      const list = this.byName.get(newKey);
      if (Array.isArray(list)) {
        if (!list.includes(conn)) list.push(conn);
      } else {
        this.byName.set(newKey, [conn]);
      }
    }
    const newFingerprint = pickTokenFingerprint(conn);
    if (newFingerprint) {
      this.byTokenFingerprint.set(`${conn.provider}:${newFingerprint}`, conn);
    }
  }
}

/**
 * Detect duplicate import records that would otherwise collapse into the same
 * existing connection.
 *
 * Updated dedup keys:
 *   - OAuth + email          → provider:oauth:email
 *   - any authType + name    → provider:authType:name
 *   - OAuth without identity → provider:oauth:fingerprint(<token>)
 *
 * The third bucket is new: previously OAuth records without email/name were
 * silently allowed through, which let the import pipeline create N near-
 * identical accounts (or, with single-OAuth-fallback, overwrite an unrelated
 * existing account multiple times).
 */
export function validateNoDuplicateImports(records) {
  const seen = new Map();
  const duplicates = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    let key;

    if (record.authType === "oauth" && record.email) {
      key = `${record.provider}:oauth:${record.email}`;
    } else if (record.name) {
      key = `${record.provider}:${record.authType}:${record.name}`;
    } else if (record.authType === "oauth") {
      const fingerprint = pickTokenFingerprint(record);
      if (!fingerprint) continue;
      key = `${record.provider}:oauth:fp:${fingerprint}`;
    } else {
      continue; // Skip records without unique identifier
    }

    if (seen.has(key)) {
      duplicates.push({
        index: i,
        firstIndex: seen.get(key),
        key,
      });
    } else {
      seen.set(key, i);
    }
  }

  return duplicates;
}
