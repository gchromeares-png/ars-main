import type { Database } from "sql.js";

const DROP_SENSITIVE_KEY = /^_*payment[-_]?session$|^(card[-_]?number|cvc|cvv|security[-_]?code)$/i;
const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|password|secret|token)/i;
const SENSITIVE_VALUE = /\b(api[-_]?key|authorization|cookie|password|secret|token|card[-_]?number|cvc|cvv|security[-_]?code)\s*[:=]\s*([^\s,;]+)/gi;

export function sanitizePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizePersistedValue(item));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_SENSITIVE_KEY.test(key)) continue;
    result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizePersistedValue(nested);
  }
  return result;
}

export function sanitizePersistedMessage(message: string): string {
  return message.replace(SENSITIVE_VALUE, (_match, label: string) => `${label}=[REDACTED]`);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

/**
 * One-way cleanup for databases created before payment sessions became strictly ephemeral.
 * Plaintext payment data is removed/redacted in place and is never migrated into the vault.
 */
export function scrubLegacySensitiveData(db: Database): void {
  const taskUpdates: Array<{ id: string; config: string; lastError: string | null }> = [];
  const taskStatement = db.prepare("SELECT id, config_json, last_error FROM tasks");
  try {
    while (taskStatement.step()) {
      const row = taskStatement.getAsObject();
      const id = asString(row["id"]);
      const rawConfig = asString(row["config_json"]);
      const rawLastError = row["last_error"] == null ? null : asString(row["last_error"]);
      try {
        const sanitizedConfig = JSON.stringify(sanitizePersistedValue(JSON.parse(rawConfig)));
        const sanitizedLastError = rawLastError == null ? null : sanitizePersistedMessage(rawLastError);
        if (sanitizedConfig !== rawConfig || sanitizedLastError !== rawLastError) {
          taskUpdates.push({ id, config: sanitizedConfig, lastError: sanitizedLastError });
        }
      } catch {
        // Malformed legacy JSON remains untouched so normal read validation can surface it.
      }
    }
  } finally {
    taskStatement.free();
  }
  for (const update of taskUpdates) {
    db.run("UPDATE tasks SET config_json = ?, last_error = ? WHERE id = ?", [update.config, update.lastError, update.id]);
  }

  const logUpdates: Array<{ id: number; message: string }> = [];
  const logStatement = db.prepare("SELECT id, message FROM task_logs");
  try {
    while (logStatement.step()) {
      const row = logStatement.getAsObject();
      const id = asNumber(row["id"]);
      const rawMessage = asString(row["message"]);
      const sanitizedMessage = sanitizePersistedMessage(rawMessage);
      if (sanitizedMessage !== rawMessage) logUpdates.push({ id, message: sanitizedMessage });
    }
  } finally {
    logStatement.free();
  }
  for (const update of logUpdates) {
    db.run("UPDATE task_logs SET message = ? WHERE id = ?", [update.message, update.id]);
  }

  const eventUpdates: Array<{ id: number; json: string }> = [];
  const eventStatement = db.prepare("SELECT id, event_json FROM product_monitor_events");
  try {
    while (eventStatement.step()) {
      const row = eventStatement.getAsObject();
      const id = asNumber(row["id"]);
      const rawJson = asString(row["event_json"]);
      try {
        const sanitizedJson = JSON.stringify(sanitizePersistedValue(JSON.parse(rawJson)));
        if (sanitizedJson !== rawJson) eventUpdates.push({ id, json: sanitizedJson });
      } catch {
        // Keep malformed legacy event JSON untouched for normal read validation.
      }
    }
  } finally {
    eventStatement.free();
  }
  for (const update of eventUpdates) {
    db.run("UPDATE product_monitor_events SET event_json = ? WHERE id = ?", [update.json, update.id]);
  }
}
