pub mod commands;

use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetVariable {
    pub name: String,
    pub label: Option<String>,
    pub default_value: Option<String>,
    pub placeholder: Option<String>,
    pub options: Option<Vec<String>>,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub folder_id: Option<String>,
    pub tags: Option<String>,
    /// JSON string of `Vec<SnippetVariable>`.  Stored as TEXT in SQLite;
    /// the frontend is responsible for parsing.
    pub variables: Option<String>,
    pub is_dangerous: bool,
    pub use_count: u32,
    pub last_used_at: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetSearchResult {
    pub snippet: Snippet,
    pub rank: f64,
}
