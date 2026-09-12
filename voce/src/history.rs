use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistoryEntry {
    pub id: i64,
    pub created_at: DateTime<Utc>,
    pub text: String,
    pub language: String,
    pub duration_ms: u64,
    pub application: Option<String>,
    pub inserted: bool,
}

pub struct HistoryStore {
    connection: Connection,
}

impl HistoryStore {
    pub fn open_default() -> Result<Self> {
        let mut path = dirs::data_dir().context("XDG data directory is unavailable")?;
        path.push("voce/history.sqlite3");
        Self::open(path)
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS history (
               id INTEGER PRIMARY KEY,
               created_at TEXT NOT NULL,
               text TEXT NOT NULL,
               language TEXT NOT NULL,
               duration_ms INTEGER NOT NULL,
               application TEXT,
               inserted INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS history_created_at ON history(created_at DESC);",
        )?;
        Ok(Self { connection })
    }

    pub fn insert(
        &self,
        text: &str,
        language: &str,
        duration_ms: u64,
        application: Option<&str>,
    ) -> Result<i64> {
        self.connection.execute(
            "INSERT INTO history(created_at, text, language, duration_ms, application) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![Utc::now().to_rfc3339(), text, language, duration_ms as i64, application],
        )?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn mark_inserted(&self, id: i64, inserted: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE history SET inserted = ?1 WHERE id = ?2",
            params![inserted, id],
        )?;
        Ok(())
    }

    pub fn list(&self, query: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
        let pattern = format!("%{}%", query);
        let mut statement = self.connection.prepare(
            "SELECT id, created_at, text, language, duration_ms, application, inserted
             FROM history WHERE text LIKE ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![pattern, limit as i64], |row| {
            let created_at: String = row.get(1)?;
            Ok((
                row.get(0)?,
                created_at,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, i64>(4)?,
                row.get(5)?,
                row.get::<_, bool>(6)?,
            ))
        })?;
        rows.map(|row| {
            let (id, created_at, text, language, duration_ms, application, inserted) = row?;
            Ok(HistoryEntry {
                id,
                created_at: DateTime::parse_from_rfc3339(&created_at)?.with_timezone(&Utc),
                text,
                language,
                duration_ms: duration_ms as u64,
                application,
                inserted,
            })
        })
        .collect()
    }

    pub fn delete(&self, id: i64) -> Result<()> {
        self.connection
            .execute("DELETE FROM history WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        self.connection.execute("DELETE FROM history", [])?;
        Ok(())
    }

    pub fn prune(&self, retention_days: u32) -> Result<usize> {
        self.connection
            .execute(
                "DELETE FROM history WHERE created_at < datetime('now', ?1)",
                [format!("-{} days", retention_days)],
            )
            .context("failed to prune transcription history")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_searches_and_deletes_entries() {
        let directory = tempfile::tempdir().unwrap();
        let store = HistoryStore::open(directory.path().join("history.db")).unwrap();
        let id = store
            .insert("Hello Voce", "en", 1200, Some("org.gnome.TextEditor"))
            .unwrap();
        assert_eq!(store.list("Voce", 10).unwrap()[0].id, id);
        store.mark_inserted(id, true).unwrap();
        assert!(store.list("", 10).unwrap()[0].inserted);
        store.delete(id).unwrap();
        assert!(store.list("", 10).unwrap().is_empty());
    }
}
