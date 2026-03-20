# SCA Implementation Specification

**Purpose:** Self-contained build spec for the Structural Content Anchor (SCA) system.  
**Language:** Rust (edition 2021, MSRV 1.75+)  
**Design reference:** `sca-proposal-full.md`

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Data Types](#2-data-types)
3. [Build Order](#3-build-order)
4. [Module 1: SimHash](#4-module-1-simhash)
5. [Module 2: Language Configs](#5-module-2-language-configs)
6. [Module 3: File Manager](#6-module-3-file-manager)
7. [Module 4: Structural Indexer](#7-module-4-structural-indexer)
8. [Module 5: Anchor Store](#8-module-5-anchor-store)
9. [Module 6: Resolution Engine](#9-module-6-resolution-engine)
10. [Module 7: Tool Handlers](#10-module-7-tool-handlers)
11. [Module 8: Router & Formatter](#11-module-8-router--formatter)
12. [Integration Tests](#12-integration-tests)
13. [Test Fixtures](#13-test-fixtures)
14. [Out of Scope for v0.1](#14-out-of-scope-for-v01)

---

## 1. Project Structure

```
sca/
├── Cargo.toml
├── src/
│   ├── main.rs                  # entry point: stdin/stdout JSON-RPC loop
│   ├── lib.rs                   # ScaState + public API
│   ├── types.rs                 # all shared data types
│   ├── simhash.rs               # SimHash (Module 1)
│   ├── lang/
│   │   ├── mod.rs               # LanguageConfig enum + registry
│   │   ├── treesitter.rs        # TreeSitterConfig trait + helpers
│   │   ├── python.rs            # Python config
│   │   └── fallback.rs          # Paragraph-based fallback
│   ├── file_manager.rs          # file I/O, versioning, path safety, snapshots (Module 3)
│   ├── indexer.rs               # tree-sitter → anchors (Module 4)
│   ├── anchor_store.rs          # session-scoped anchor storage (Module 5)
│   ├── resolver.rs              # anchor → byte range (Module 6)
│   ├── tools/
│   │   ├── mod.rs               # dispatch
│   │   ├── observe.rs           # OBSERVE
│   │   ├── match_tool.rs        # MATCH
│   │   ├── patch.rs             # PATCH
│   │   └── commit.rs            # COMMIT
│   ├── router.rs                # JSON-RPC stdin/stdout
│   └── formatter.rs             # model-facing output
├── tests/
│   ├── fixtures/
│   │   ├── python/
│   │   │   ├── session.py
│   │   │   └── middleware.py
│   │   └── notes.txt
│   ├── unit/
│   │   ├── simhash_test.rs
│   │   ├── indexer_test.rs
│   │   ├── resolver_test.rs
│   │   └── file_manager_test.rs
│   └── integration/
│       └── end_to_end_test.rs
└── README.md
```

**Cargo.toml:**

```toml
[package]
name = "sca"
version = "0.1.0"
edition = "2021"

[dependencies]
tree-sitter = "0.24"
tree-sitter-python = "0.23"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
rand = "0.8"
regex = "1"
tempfile = "3"               # atomic writes (temp file + rename)

[dev-dependencies]
assert_cmd = "2"             # integration tests that spawn the binary
```

No `notify` (file watching deferred), no `lru` (manual LRU in FileManager), no `glob`/`walkdir` (manual directory walking). Only `tree-sitter-python` in v0.1.


---

## 2. Data Types

All types in `src/types.rs`.

```rust
use std::collections::HashMap;
use std::ops::Range;
use std::path::PathBuf;

// ─── Primitives ────────────────────────────────────────────

/// Short unique identifier with "@" prefix, e.g., "@a_7f3c"
pub type AnchorId = String;

/// Monotonic counter per file, incremented on every write
pub type FileVersion = u64;

/// 64-bit SimHash fingerprint
pub type SimHashValue = u64;

// ─── Node Kinds ────────────────────────────────────────────
// Separate enums for code vs text node types

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "category", content = "kind")]
pub enum NodeKind {
    Code(CodeNodeKind),
    Text(TextNodeKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodeNodeKind {
    Module,
    Class,
    Function,
    Method,
    Block,       // if, for, while, try, with, match
    Statement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextNodeKind {
    Document,
    Paragraph,   // used by fallback (blank-line-delimited)
}

// ─── Anchor ────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Anchor {
    pub id: AnchorId,
    pub file: String,                    // relative path from project root
    pub structural: StructuralInfo,
    pub contextual: ContextualInfo,
    pub positional: PositionalInfo,
    pub kind: NodeKind,
    pub parent: Option<AnchorId>,
    pub created_at_version: FileVersion,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StructuralInfo {
    pub path: String,                    // e.g., "auth.session:SessionManager.validate_token"
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContextualInfo {
    pub hash: SimHashValue,
    pub version: FileVersion,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PositionalInfo {
    pub byte_start: usize,
    pub byte_end: usize,
    pub line_start: usize,              // 1-indexed
    pub line_end: usize,                // 1-indexed, inclusive
    pub ordinal: usize,                 // 0-indexed: Nth sibling of same type
    pub ordinal_context: String,        // e.g., "3rd method in SessionManager"
}

// ─── Resolution ────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ResolvedAnchor {
    pub anchor: Anchor,
    pub byte_range: Range<usize>,
    pub confidence: f64,               // 0.0 to 1.0
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StalenessHint {
    Fresh,
    LikelyOk,
    Stale,
    Invalid,
}

// ─── Tool inputs ───────────────────────────────────────────
// Each operation variant carries its own required fields (no Option<String> ambiguity)
// so there's no Option<String> that gets unwrap()'d

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "tool", content = "params")]
#[serde(rename_all = "snake_case")]
pub enum ToolCall {
    Observe(ObserveParams),
    Match(MatchParams),
    Patch(PatchParams),
    Commit(CommitParams),
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ObserveParams {
    pub target: String,                  // file path, dir, glob, or "@a_XXXX"
    #[serde(default = "default_lens")]
    pub lens: Lens,
    #[serde(default = "default_depth")]
    pub depth: usize,
    // NOTE: `filter` removed from v0.1. Add back in v0.2 as regex against structural path.
}

fn default_lens() -> Lens { Lens::Full }
fn default_depth() -> usize { 2 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Lens {
    Full,
    Signatures,
    Skeleton,
    Scope,
}
// Note: Lens::Diff removed from v0.1

#[derive(Debug, Clone, serde::Deserialize)]
pub struct MatchParams {
    pub query: String,
    #[serde(default = "default_match_mode")]
    pub mode: MatchMode,
    pub scope: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_match_mode() -> MatchMode { MatchMode::Text }
fn default_limit() -> usize { 20 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    Text,
    // Structural, Reference, Semantic all deferred to v0.2+
}

/// Each operation variant carries its own required fields.
/// No shared Option<String> fields that need runtime validation.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(tag = "operation")]
#[serde(rename_all = "snake_case")]
pub enum PatchParams {
    Replace {
        anchor: AnchorId,
        content: String,
        #[serde(default)]
        cas_version: Option<FileVersion>,
        #[serde(default = "default_true")]
        validate: bool,
    },
    InsertBefore {
        anchor: AnchorId,
        content: String,
        #[serde(default)]
        cas_version: Option<FileVersion>,
    },
    InsertAfter {
        anchor: AnchorId,
        content: String,
        #[serde(default)]
        cas_version: Option<FileVersion>,
    },
    Delete {
        anchor: AnchorId,
        #[serde(default)]
        cas_version: Option<FileVersion>,
    },
    Rename {
        anchor: AnchorId,
        rename_to: String,
        #[serde(default)]
        cas_version: Option<FileVersion>,
    },
    // Wrap removed from v0.1
}

fn default_true() -> bool { true }

impl PatchParams {
    /// Extract the anchor id regardless of variant
    pub fn anchor_id(&self) -> &str {
        match self {
            PatchParams::Replace { anchor, .. } => anchor,
            PatchParams::InsertBefore { anchor, .. } => anchor,
            PatchParams::InsertAfter { anchor, .. } => anchor,
            PatchParams::Delete { anchor, .. } => anchor,
            PatchParams::Rename { anchor, .. } => anchor,
        }
    }

    /// Extract the cas_version regardless of variant
    pub fn cas_version(&self) -> Option<FileVersion> {
        match self {
            PatchParams::Replace { cas_version, .. } => *cas_version,
            PatchParams::InsertBefore { cas_version, .. } => *cas_version,
            PatchParams::InsertAfter { cas_version, .. } => *cas_version,
            PatchParams::Delete { cas_version, .. } => *cas_version,
            PatchParams::Rename { cas_version, .. } => *cas_version,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct CommitParams {
    pub action: CommitAction,
    pub label: Option<String>,
    pub r#ref: Option<String>,
    #[serde(default = "default_undo_count")]
    pub count: usize,
}

fn default_undo_count() -> usize { 1 }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitAction {
    Snapshot,
    Restore,
    Log,
    Undo,
    // Diff removed from v0.1
}

// ─── Tool outputs ──────────────────────────────────────────

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ToolResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub anchors: Vec<AnchorDisplay>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inverse: Option<PatchParams>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolError>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AnchorDisplay {
    pub id: AnchorId,
    pub display: String,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ToolError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<AnchorId>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<AnchorDisplay>,
    pub suggestion: String,
}

impl ToolError {
    /// Convenience constructor for the common case.
    pub fn new(kind: &str, message: impl Into<String>, suggestion: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
            suggestion: suggestion.into(),
            ..Default::default()
        }
    }

    /// Attach an anchor id to the error.
    pub fn with_anchor(mut self, anchor: AnchorId) -> Self {
        self.anchor = Some(anchor);
        self
    }

    /// Attach candidate anchors.
    pub fn with_candidates(mut self, candidates: Vec<AnchorDisplay>) -> Self {
        self.candidates = candidates;
        self
    }
}

/// Internal error enum used by FileManager and other internal APIs.
/// Converted to ToolError at the handler boundary.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Path escapes project root: {0}")]
    PathEscapes(String),

    #[error("Snapshot not found: {0}")]
    SnapshotNotFound(String),

    #[error("Nothing to undo")]
    NothingToUndo,

    #[error("File too large: {0} is {1} bytes (max {2})")]
    FileTooLarge(String, u64, usize),

    #[error("CAS conflict on {file}: expected {expected}, got {actual}")]
    CasConflict { file: String, expected: String, actual: String },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    /// Convert internal Error to ToolError suitable for JSON-RPC response.
    /// SECURITY: scrub absolute filesystem paths — only expose project-relative paths.
    pub fn to_tool_error(&self, root: &Path) -> ToolError {
        match self {
            Error::FileNotFound(path) => ToolError::new(
                "FILE_NOT_FOUND",
                format!("File not found: {}", path),
                "Check the file path with OBSERVE",
            ),
            Error::PathEscapes(path) => ToolError::new(
                "PATH_DENIED",
                format!("Path not allowed: {}", sanitize_path(path, root)),
                "Use paths relative to the project root",
            ),
            Error::SnapshotNotFound(label) => ToolError::new(
                "SNAPSHOT_NOT_FOUND",
                format!("Snapshot '{}' does not exist", label),
                "Use COMMIT snapshot to create one first",
            ),
            Error::NothingToUndo => ToolError::new(
                "NOTHING_TO_UNDO",
                "No edits to undo",
                "Make an edit first with PATCH",
            ),
            Error::FileTooLarge(path, size, max) => ToolError::new(
                "FILE_TOO_LARGE",
                format!("File {} is {} bytes (max {})", path, size, max),
                "Split the file or use a different approach",
            ),
            Error::CasConflict { file, expected, actual } => ToolError::new(
                "CAS_CONFLICT",
                format!("File '{}' was modified externally (expected {}, got {})", file, expected, actual),
                "Re-read the file with OBSERVE to get the current version",
            ),
            Error::Io(e) => {
                // SECURITY: std::io::Error can contain absolute paths.
                // Log the full error internally, but sanitize for the response.
                let msg = e.to_string();
                let sanitized = sanitize_path(&msg, root);
                ToolError::new("IO_ERROR", sanitized, "Check file permissions and disk space")
            }
        }
    }
}

/// Strip sensitive filesystem paths from error messages.
/// - Replaces the project root with relative paths
/// - Strips common sensitive prefixes (/home/user, /tmp, etc.)
/// - Handles edge case where root is "/" (don't replace every slash)
fn sanitize_path(msg: &str, root: &Path) -> String {
    let root_str = root.to_string_lossy();
    let mut result = msg.to_string();

    // Don't do root replacement if root is "/" — that would mangle everything
    if root_str != "/" {
        // Replace with-trailing-slash first (more specific) to get clean relative paths
        let with_slash = format!("{}/", root_str);
        result = result.replace(&with_slash, "");
        // Then replace bare root with placeholder
        result = result.replace(root_str.as_ref(), "<project>");
    }

    // Strip other absolute paths that may leak from std::io::Error or other sources.
    // Replace /home/<user>/... and /Users/<user>/... with <redacted>/...
    // Use a regex-free approach: find sequences starting with common prefixes.
    for prefix in &["/home/", "/Users/", "/root/", "/tmp/", "/var/"] {
        while let Some(start) = result.find(prefix) {
            // Find the end of the path (next space, quote, colon, or end of string)
            let rest = &result[start..];
            let end = rest.find(|c: char| c == ' ' || c == '"' || c == '\'' || c == ':')
                .unwrap_or(rest.len());
            result.replace_range(start..start + end, "<redacted>");
        }
    }

    result
}
```

**Use `ToolError::new()` consistently across all handlers.** Examples:

```rust
// Instead of this (verbose, inconsistent):
ToolError { kind: "RESOLUTION_FAILED".into(), message: "...".into(), anchor: None, candidates: vec![], suggestion: "...".into() }

// Write this:
ToolError::new("RESOLUTION_FAILED", "Anchor not found", "Re-OBSERVE the file")
    .with_anchor(anchor_id)
```
```


---

## 3. Build Order

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6 ──► Phase 7
types       lang/        file_mgr    indexer      anchor      resolver    tools
simhash     python       (path       (tree-sitter  store                  router
            fallback      safety)     + simhash)                          formatter
                                                                          main
```

| Phase | Modules | Gate (all must pass before next phase) |
|---|---|---|
| 1 | `types.rs`, `simhash.rs` | SimHash unit tests pass. Types compile. |
| 2 | `lang/mod.rs`, `lang/treesitter.rs`, `lang/python.rs`, `lang/fallback.rs` | Python: parses fixture, extracts names. Fallback: splits into paragraphs. |
| 3 | `file_manager.rs` | Path safety tests pass (traversal blocked). Atomic write test passes. Read/write/version/snapshot/restore/undo all pass. Resource limits enforced. |
| 4 | `indexer.rs` | Indexes Python fixture → correct structural paths, SimHashes, ordinals. Indexes plain text → correct paragraphs. Two-pass parent assignment works. |
| 5 | `anchor_store.rs` | Store/retrieve/GC/invalidate/hard-cap all pass. |
| 6 | `resolver.rs` | Fresh resolution. Stale resolution (edit elsewhere). Stale resolution (content changed). Resolution after delete → error. CAS conflict detected. `get_or_rebuild_index` invalidation correct. |
| 7 | `tools/*`, `router.rs`, `formatter.rs`, `main.rs` | All 12 integration tests pass (Section 12). |

**Rule: do NOT start Phase N+1 until Phase N's gate passes.**


---

## 4. Module 1: SimHash

**File:** `src/simhash.rs`  
**Dependencies:** none (std only)

### Interface

```rust
/// Compute 64-bit SimHash of text.
/// If `normalize`: strip leading/trailing whitespace per line, collapse
/// runs of whitespace to single space, remove blank lines.
pub fn simhash(text: &str, normalize: bool) -> SimHashValue;

/// Hamming distance (popcount of XOR).
pub fn hamming_distance(a: SimHashValue, b: SimHashValue) -> u32;

pub const IDENTICAL: u32 = 0;
pub const SIMILAR_MAX: u32 = 6;     // distance ≤ 6 = "similar content"
pub const DIFFERENT_MIN: u32 = 12;   // distance ≥ 12 = "different content"
```

### Tokenization

```rust
fn tokenize(text: &str) -> Vec<&str> {
    // Split on transitions between:
    //   - ASCII alphanumeric/underscore runs: [a-zA-Z0-9_]+
    //   - ASCII operator/punctuation: each character individually
    //   - Non-ASCII: each codepoint as a single token
    //
    // String literals are NOT stripped — they are part of the content fingerprint.
    // Two functions differing only in string values should have different hashes.
    //
    // Examples:
    //   "def foo(x):"  → ["def", "foo", "(", "x", ")", ":"]
    //   "x = 'hello'"  → ["x", "=", "'", "hello", "'"]
    //   "café"          → ["caf", "é"]  (non-ASCII split)
    //   ""              → []
}
```

### Algorithm

```
fn simhash(text, normalize):
    if normalize:
        text = text.lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    tokens = tokenize(text)
    if tokens.is_empty():
        return 0
    vector = [0i64; 64]
    for token in tokens:
        // NOTE: DefaultHasher (SipHash-1-3) is not guaranteed stable across Rust versions.
        // This is fine because SimHash values are ephemeral (per-session, never persisted).
        // If SimHash values were ever saved to disk, switch to a fixed algorithm (e.g., FxHash).
        h = hash64(token)   // use std::hash::DefaultHasher (SipHash)
        for bit in 0..64:
            if h & (1u64 << bit) != 0:
                vector[bit] += 1
            else:
                vector[bit] -= 1
    fingerprint = 0u64
    for bit in 0..64:
        if vector[bit] > 0:
            fingerprint |= 1u64 << bit
    fingerprint

fn hamming_distance(a, b):
    (a ^ b).count_ones()
```

### Tests

```
test_identical:
    assert hamming_distance(simhash("def foo(): return 1", true),
                            simhash("def foo(): return 1", true)) == 0

test_whitespace_normalized:
    assert hamming_distance(simhash("def foo():\n    return 1", true),
                            simhash("def foo():\n        return 1", true)) == 0

test_small_change_close:
    a = simhash("def foo():\n    return 1", true)
    b = simhash("def foo():\n    return 2", true)
    assert hamming_distance(a, b) <= SIMILAR_MAX

test_different_far:
    a = simhash("def foo():\n    return 1", true)
    b = simhash("class Bar:\n    x = [1,2,3]\n    def baz(self): pass", true)
    assert hamming_distance(a, b) >= DIFFERENT_MIN

test_string_content_matters:
    a = simhash("print('hello')", true)
    b = simhash("print('world')", true)
    assert hamming_distance(a, b) > 0

test_empty:
    assert simhash("", true) == 0
    assert simhash("   \n  \n  ", true) == 0

test_unicode:
    // should not panic
    let h = simhash("def café(): return '日本語'", true);
    assert h != 0
```


---

## 5. Module 2: Language Configs

**File:** `src/lang/mod.rs`, `src/lang/treesitter.rs`, `src/lang/python.rs`, `src/lang/fallback.rs`  
**Dependencies:** `tree-sitter`, `types.rs`, `simhash.rs`

### Architecture

```rust
// src/lang/mod.rs

/// What kind of language support does this file get?
pub enum LanguageConfig {
    TreeSitter(Box<dyn TreeSitterConfig>),
    Fallback(FallbackConfig),
}

/// Maps file extension → LanguageConfig
pub struct LanguageRegistry {
    ts_configs: HashMap<String, Box<dyn TreeSitterConfig>>,
    // no entry = use FallbackConfig
}

impl LanguageRegistry {
    pub fn new() -> Self {
        let mut reg = Self { ts_configs: HashMap::new() };
        reg.register(PythonConfig::new());
        reg
    }

    pub fn config_for_file(&self, path: &str) -> LanguageConfig {
        let ext = Path::new(path).extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        match self.ts_configs.get(ext) {
            Some(config) => LanguageConfig::TreeSitter(config.clone_box()),
            None => LanguageConfig::Fallback(FallbackConfig),
        }
    }
}
```

### TreeSitterConfig trait

```rust
// src/lang/treesitter.rs

pub trait TreeSitterConfig: Send + Sync {
    /// tree-sitter Language grammar
    fn language(&self) -> tree_sitter::Language;

    /// File extensions
    fn extensions(&self) -> &[&str];

    /// Is this node type worth anchoring?
    fn is_anchorable(&self, node: &tree_sitter::Node) -> bool;

    /// Extract name from node. None for anonymous nodes (if, for, etc.)
    fn extract_name(&self, node: &tree_sitter::Node, source: &[u8]) -> Option<String>;

    /// What kind is this node?
    fn node_kind(&self, node: &tree_sitter::Node) -> NodeKind;

    /// Node types that are comments
    fn comment_node_types(&self) -> &[&str];

    /// Node types that are identifiers. Used by rename to find all occurrences.
    /// Different languages use different node kinds:
    /// - Python: ["identifier"]
    /// - Rust: ["identifier", "type_identifier", "field_identifier"]
    /// - TypeScript: ["identifier", "property_identifier", "type_identifier"]
    fn identifier_node_types(&self) -> &[&str] {
        &["identifier"]  // default, override per language
    }

    /// Node types that are string literals. Used by rename to skip matches inside strings.
    /// Override per language to avoid false positives/negatives from heuristic matching.
    /// - Python: ["string", "concatenated_string"]
    /// - Rust: ["string_literal", "raw_string_literal", "char_literal"]
    /// - TypeScript: ["string", "template_string"]
    fn string_node_types(&self) -> &[&str] {
        &["string", "string_literal"]  // default covers most languages
    }

    /// Strip comments from a node's source text.
    /// Uses recursive tree-sitter cursor walk to find ALL comment nodes
    /// at any depth, then rebuilds the text with those ranges removed.
    fn strip_comments(&self, node: &tree_sitter::Node, source: &[u8]) -> String {
        let comment_types = self.comment_node_types();
        let mut comment_ranges: Vec<Range<usize>> = Vec::new();

        // Collect all comment ranges recursively
        fn collect_comments(
            node: &tree_sitter::Node,
            comment_types: &[&str],
            ranges: &mut Vec<Range<usize>>,
        ) {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if comment_types.contains(&child.kind()) {
                    ranges.push(child.start_byte()..child.end_byte());
                } else {
                    collect_comments(&child, comment_types, ranges);
                }
            }
        }
        collect_comments(node, &comment_types, &mut comment_ranges);

        // Sort by start position (should already be sorted, but be safe)
        comment_ranges.sort_by_key(|r| r.start);

        // Build result by copying non-comment ranges
        let mut result = String::new();
        let mut pos = node.start_byte();
        for range in &comment_ranges {
            if range.start > pos {
                result.push_str(
                    std::str::from_utf8(&source[pos..range.start]).unwrap_or("")
                );
            }
            pos = range.end;
        }
        if pos < node.end_byte() {
            result.push_str(
                std::str::from_utf8(&source[pos..node.end_byte()]).unwrap_or("")
            );
        }
        result
    }

    /// Clone into Box (for registry)
    fn clone_box(&self) -> Box<dyn TreeSitterConfig>;
}
```

### Python config

```rust
// src/lang/python.rs

#[derive(Clone)]
pub struct PythonConfig;

impl PythonConfig {
    pub fn new() -> Self { PythonConfig }
}

impl TreeSitterConfig for PythonConfig {
    fn language(&self) -> tree_sitter::Language {
        tree_sitter_python::language()
    }

    fn extensions(&self) -> &[&str] { &["py", "pyi"] }

    fn is_anchorable(&self, node: &tree_sitter::Node) -> bool {
        matches!(node.kind(),
            "module" |
            "class_definition" |
            "function_definition" |
            "decorated_definition" |
            "if_statement" |
            "for_statement" |
            "while_statement" |
            "try_statement" |
            "with_statement"
        )
    }

    fn extract_name(&self, node: &tree_sitter::Node, source: &[u8]) -> Option<String> {
        match node.kind() {
            "class_definition" | "function_definition" => {
                node.child_by_field_name("name")
                    .and_then(|n| n.utf8_text(source).ok())
                    .map(|s| s.to_string())
            }
            "decorated_definition" => {
                // Recurse into the "definition" field
                node.child_by_field_name("definition")
                    .and_then(|def| self.extract_name(&def, source))
            }
            _ => None // anonymous structural nodes (if, for, etc.)
        }
    }

    fn node_kind(&self, node: &tree_sitter::Node) -> NodeKind {
        match node.kind() {
            "module" => NodeKind::Code(CodeNodeKind::Module),
            "class_definition" => NodeKind::Code(CodeNodeKind::Class),
            "function_definition" => {
                // Method if parent is class_definition (or inside one)
                let mut parent = node.parent();
                while let Some(p) = parent {
                    if p.kind() == "class_definition" {
                        return NodeKind::Code(CodeNodeKind::Method);
                    }
                    // decorated_definition wraps, keep looking
                    if p.kind() != "decorated_definition" && p.kind() != "block" {
                        break;
                    }
                    parent = p.parent();
                }
                NodeKind::Code(CodeNodeKind::Function)
            }
            "decorated_definition" => {
                // Delegate to the inner definition
                node.child_by_field_name("definition")
                    .map(|def| self.node_kind(&def))
                    .unwrap_or(NodeKind::Code(CodeNodeKind::Function))
            }
            "if_statement" | "for_statement" | "while_statement" |
            "try_statement" | "with_statement" => {
                NodeKind::Code(CodeNodeKind::Block)
            }
            _ => NodeKind::Code(CodeNodeKind::Statement),
        }
    }

    fn comment_node_types(&self) -> &[&str] { &["comment"] }

    fn clone_box(&self) -> Box<dyn TreeSitterConfig> { Box::new(self.clone()) }
}
```

### Fallback config (no tree-sitter)

```rust
// src/lang/fallback.rs

/// Paragraph-based fallback for files without tree-sitter grammars.
/// Splits on blank lines. Each paragraph is a TextBlock anchor.
#[derive(Clone)]
pub struct FallbackConfig;

impl FallbackConfig {
    /// Split content into paragraph byte ranges.
    /// A paragraph is a contiguous run of non-blank lines.
    /// Blank line = line containing only whitespace.
    /// Handles both \n and \r\n line endings.
    pub fn split_paragraphs(content: &str) -> Vec<Range<usize>> {
        let mut paragraphs = Vec::new();
        let mut para_start: Option<usize> = None;
        let mut pos = 0;

        for line in content.lines() {
            let line_end = pos + line.len();
            if line.trim().is_empty() {
                if let Some(start) = para_start {
                    paragraphs.push(start..pos); // end before the blank line
                    para_start = None;
                }
            } else if para_start.is_none() {
                para_start = Some(pos);
            }
            // Advance past line content + line ending.
            // content.lines() strips \n and \r\n, so we need to detect which was used.
            pos = line_end;
            if pos < content.len() && content.as_bytes()[pos] == b'\r' {
                pos += 1; // skip \r
            }
            if pos < content.len() && content.as_bytes()[pos] == b'\n' {
                pos += 1; // skip \n
            }
        }
        if let Some(start) = para_start {
            paragraphs.push(start..content.len());
        }
        paragraphs
    }
}
```

### file_path_to_module

```rust
/// Convert a relative file path to a module path.
///
/// Rules:
/// 1. Strip known extensions: .py, .pyi, .rs, .ts, .tsx, .js, .jsx, .go, .java, .txt, .md
/// 2. Replace path separators with '.'
/// 3. Path is always relative to project root (enforced by FileManager)
///
/// Examples:
///   "auth/session.py"        → "auth.session"
///   "src/app.ts"             → "src.app"
///   "session.test.py"        → "session.test"   (only last extension stripped)
///   "notes.txt"              → "notes"
///   "README"                 → "README"          (no extension to strip)
pub fn file_path_to_module(path: &str) -> String {
    let p = Path::new(path);
    let stem = match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if ["py","pyi","rs","ts","tsx","js","jsx","go","java","txt","md"]
                     .contains(&ext) => {
            // Strip extension
            p.with_extension("").to_string_lossy().to_string()
        }
        _ => path.to_string()
    };
    stem.replace(std::path::MAIN_SEPARATOR, ".").replace('/', ".")
}
```

### Tests

```
test_python_extracts_function_name:
    parse "def validate_token(self, token): pass"
    assert extract_name → Some("validate_token")

test_python_extracts_class_name:
    parse "class Foo:\n    pass"
    assert extract_name → Some("Foo")

test_python_method_vs_function:
    parse "class Foo:\n    def bar(self): pass"
    bar's node_kind → Code(Method)
    parse "def baz(): pass"
    baz's node_kind → Code(Function)

test_python_decorated:
    parse "@decorator\ndef foo(): pass"
    extract_name on decorated_definition → Some("foo")

test_python_comment_stripping:
    parse "def foo():\n    # comment\n    return 1"
    strip_comments → "def foo():\n    \n    return 1"  (comment text removed)

test_fallback_paragraphs:
    content = "first\nstill first\n\nsecond\n\nthird"
    FallbackConfig::split_paragraphs(content) → 3 ranges

test_fallback_empty:
    FallbackConfig::split_paragraphs("") → 0 ranges

test_fallback_no_blank_lines:
    FallbackConfig::split_paragraphs("one\ntwo\nthree") → 1 range (whole file)

test_fallback_crlf:
    content = "first\r\nstill first\r\n\r\nsecond\r\n\r\nthird"
    FallbackConfig::split_paragraphs(content) → 3 ranges
    assert ranges byte-index correctly into the original content (accounting for \r\n)

test_file_path_to_module:
    assert file_path_to_module("auth/session.py") == "auth.session"
    assert file_path_to_module("session.test.py") == "session.test"
    assert file_path_to_module("notes.txt") == "notes"
    assert file_path_to_module("README") == "README"
```


---

## 6. Module 3: File Manager

**File:** `src/file_manager.rs`  
**Dependencies:** `types.rs`

### Design Principles

1. **All paths canonicalized** — Every file operation goes through `safe_resolve()` or `safe_resolve_for_write()`. No raw filesystem access.
2. **Atomic writes** — Uses temp-file + rename via the `tempfile` crate (which must be a runtime dep, not just dev-dep).
3. **Re-read before write** — `write()` re-reads from disk (not cache) to capture accurate old_content for undo and to detect TOCTOU races.
4. **Bounded everything** — Cache, edit log, and snapshots all have hard caps with eviction.

### Resource Limits

```rust
const MAX_CACHED_FILES: usize = 200;
const MAX_SNAPSHOTS: usize = 10;
const MAX_EDIT_LOG_ENTRIES: usize = 200;
const MAX_EDIT_LOG_BYTES: usize = 50 * 1024 * 1024;  // 50 MB total budget for undo history
const MAX_FILE_SIZE: usize = 10 * 1024 * 1024;       // 10 MB per file — reject larger files
```

**Memory budget note:** Worst case with full snapshots + full edit log is approximately:
- Snapshots: 10 × (known files × avg file size). With 200 known files of 50KB avg = ~100MB.
- Edit log: 50MB cap.
- File cache: 200 × 50KB = ~10MB.
- Total worst case: ~160MB. Acceptable for a developer tool running on a workstation.
  If this proves too high in practice, reduce MAX_SNAPSHOTS to 5 or MAX_EDIT_LOG_BYTES to 25MB.

### Interface

```rust
pub struct FileManager {
    root: PathBuf,
    versions: HashMap<String, FileVersion>,

    /// In-memory file content cache. Simple HashMap + VecDeque for LRU eviction.
    /// Do NOT use the `lru` crate — implement manually to avoid hidden API assumptions.
    cache_map: HashMap<String, String>,     // relative path → content
    cache_order: VecDeque<String>,          // most recently used at back

    /// Edit log for undo. Bounded by both entry count and total memory.
    edit_log: VecDeque<EditLogEntry>,
    edit_log_bytes: usize,                  // running total of old_content + new_content sizes

    /// Snapshots. Bounded to MAX_SNAPSHOTS.
    snapshots: HashMap<String, Snapshot>,

    /// Set of files this session has read or written (for snapshot tracking).
    /// Updated on every read() and write().
    known_files: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct EditLogEntry {
    pub file: String,
    pub old_content: String,      // restored directly on undo
    pub new_content: String,      // kept so we can verify consistency
    pub timestamp: std::time::SystemTime,
    pub entry_bytes: usize,       // old_content.len() + new_content.len()
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub label: String,
    pub files: HashMap<String, String>,    // relative path → content at snapshot time
    pub file_list: HashSet<String>,        // ALL files that existed at snapshot time
    pub timestamp: std::time::SystemTime,
}

impl FileManager {
    pub fn new(root: PathBuf) -> Result<Self, Error> {
        let root = root.canonicalize()?;
        if !root.is_dir() {
            return Err(Error::NotADirectory(root));
        }
        Ok(Self {
            root,
            versions: HashMap::new(),
            cache_map: HashMap::new(),
            cache_order: VecDeque::new(),
            edit_log: VecDeque::new(),
            edit_log_bytes: 0,
            snapshots: HashMap::new(),
            known_files: HashSet::new(),
        })
    }

    /// Read a file. Returns content and version.
    /// Detects external changes by comparing to cached content.
    pub fn read(&mut self, relative_path: &str) -> Result<(String, FileVersion), Error> {
        let abs = self.safe_resolve(relative_path)?;

        // Check file size before reading into memory
        let metadata = std::fs::metadata(&abs)?;
        if metadata.len() > MAX_FILE_SIZE as u64 {
            return Err(Error::FileTooLarge(relative_path.to_string(), metadata.len(), MAX_FILE_SIZE));
        }

        let content = std::fs::read_to_string(&abs)?;

        let version = self.versions.entry(relative_path.to_string()).or_insert(0);
        if let Some(cached) = self.cache_map.get(relative_path) {
            if cached != &content {
                *version += 1;  // external change detected
            }
        } else {
            // First read of this file: ensure version is at least 1
            *version = (*version).max(1);
        }

        self.cache_put(relative_path, content.clone());
        self.known_files.insert(relative_path.to_string());
        Ok((content, *version))
    }

    /// Write content atomically. Increments version. Logs edit for undo.
    /// Re-reads from disk before writing to catch concurrent external edits.
    pub fn write(&mut self, relative_path: &str, content: &str) -> Result<FileVersion, Error> {
        let abs = self.safe_resolve_for_write(relative_path)?;

        // Re-read current content from disk (not cache) for accurate undo
        let old_content = std::fs::read_to_string(&abs).unwrap_or_default();

        // Atomic write: temp file + rename
        atomic_write(&abs, content, &self.root)?;

        let version = self.versions.entry(relative_path.to_string()).or_insert(0);
        *version += 1;
        let new_version = *version;

        self.cache_put(relative_path, content.to_string());
        self.known_files.insert(relative_path.to_string());

        // Append to edit log (bounded by both count and total bytes)
        let entry_bytes = old_content.len() + content.len();
        self.trim_edit_log(entry_bytes);
        self.edit_log.push_back(EditLogEntry {
            file: relative_path.to_string(),
            old_content,
            new_content: content.to_string(),
            timestamp: std::time::SystemTime::now(),
            entry_bytes,
        });
        self.edit_log_bytes += entry_bytes;

        Ok(new_version)
    }

    /// Trim edit log to stay within both count and memory budget.
    fn trim_edit_log(&mut self, incoming_bytes: usize) {
        while self.edit_log.len() >= MAX_EDIT_LOG_ENTRIES
            || (self.edit_log_bytes + incoming_bytes > MAX_EDIT_LOG_BYTES && !self.edit_log.is_empty())
        {
            if let Some(evicted) = self.edit_log.pop_front() {
                self.edit_log_bytes -= evicted.entry_bytes;
            }
        }
    }

    /// Apply a byte-range replacement. Returns new version.
    pub fn edit_range(&mut self, relative_path: &str, range: Range<usize>, new_text: &str) -> Result<FileVersion, Error> {
        let (current, _) = self.read(relative_path)?;
        if range.end > current.len() {
            return Err(Error::InvalidRange(range, current.len()));
        }
        let mut new_content = String::with_capacity(current.len() - range.len() + new_text.len());
        new_content.push_str(&current[..range.start]);
        new_content.push_str(new_text);
        new_content.push_str(&current[range.end..]);
        self.write(relative_path, &new_content)
    }

    /// Take a snapshot of all files this session has touched.
    /// Reads each known file from disk to capture current state.
    /// Enforces MAX_SNAPSHOTS (evicts oldest on overflow).
    pub fn snapshot(&mut self, label: &str) -> Result<(), Error> {
        if self.snapshots.len() >= MAX_SNAPSHOTS {
            let oldest = self.snapshots.iter()
                .min_by_key(|(_, s)| s.timestamp)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest { self.snapshots.remove(&k); }
        }

        // Read all known files from disk (not cache) for accurate snapshot
        let mut files = HashMap::new();
        let mut file_list = HashSet::new();
        for path in &self.known_files {
            let abs = self.safe_resolve(path)?;
            if abs.exists() {
                let content = std::fs::read_to_string(&abs)?;
                files.insert(path.clone(), content);
                file_list.insert(path.clone());
            }
        }

        self.snapshots.insert(label.to_string(), Snapshot {
            label: label.to_string(), files, file_list, timestamp: std::time::SystemTime::now()
        });
        Ok(())
    }

    /// Restore a snapshot. Restores file contents AND deletes files created after snapshot.
    pub fn restore(&mut self, label: &str) -> Result<Vec<String>, Error> {
        let snapshot = self.snapshots.get(label)
            .ok_or(Error::SnapshotNotFound(label.to_string()))?
            .clone();
        let mut changed = Vec::new();

        // Restore files from snapshot
        for (path, content) in &snapshot.files {
            self.write(path, content)?;
            changed.push(path.clone());
        }

        // Delete files created after the snapshot.
        // Log each deletion in the edit log so undo can recreate the files.
        let current_files: HashSet<String> = self.known_files.clone();
        for path in current_files.difference(&snapshot.file_list) {
            let abs = self.safe_resolve(path)?;
            if abs.exists() {
                // Read current content before deleting, so undo can restore it
                let content = std::fs::read_to_string(&abs).unwrap_or_default();
                self.push_edit_log(EditLogEntry {
                    file: path.clone(),
                    old_content: content,
                    new_content: String::new(),  // empty = file was deleted
                    entry_bytes: 0,  // will be set by push_edit_log
                });
                std::fs::remove_file(&abs)?;
            }
            self.cache_map.remove(path);
            self.versions.remove(path);
            self.known_files.remove(path);
            changed.push(path.clone());
        }

        Ok(changed)
    }

    /// Undo last N edits by restoring old_content directly.
    ///
    /// DESIGN NOTE: Undo does NOT log itself in the edit log. This is intentional —
    /// undo replays backwards, so logging undo operations would create an infinite
    /// loop. To "redo" after undo, the model should use PATCH to re-apply the change.
    pub fn undo(&mut self, count: usize) -> Result<Vec<String>, Error> {
        let mut changed = Vec::new();
        for _ in 0..count {
            let entry = self.edit_log.pop_back()
                .ok_or(Error::NothingToUndo)?;
            self.edit_log_bytes -= entry.entry_bytes;

            if entry.new_content.is_empty() && !entry.old_content.is_empty() {
                // This was a file deletion during restore — recreate the file
                let abs = self.safe_resolve_for_write(&entry.file)?;
                atomic_write(&abs, &entry.old_content, &self.root)?;
                self.known_files.insert(entry.file.clone());
            } else if entry.old_content.is_empty() && !entry.new_content.is_empty() {
                // This was a file creation — delete it
                let abs = self.safe_resolve(&entry.file)?;
                if abs.exists() {
                    std::fs::remove_file(&abs)?;
                }
                self.known_files.remove(&entry.file);
                self.cache_map.remove(&entry.file);
            } else {
                // Normal edit — restore old content
                // CAS check: verify current content matches what the edit produced
                let abs = self.safe_resolve(&entry.file)?;
                let current = std::fs::read_to_string(&abs).unwrap_or_default();
                if current != entry.new_content {
                    return Err(Error::CasConflict {
                        file: entry.file.clone(),
                        expected: "content matching last edit".into(),
                        actual: "externally modified content".into(),
                    });
                }
                atomic_write(&abs, &entry.old_content, &self.root)?;
            }

            let version = self.versions.entry(entry.file.clone()).or_insert(0);
            *version += 1;
            if !entry.old_content.is_empty() {
                self.cache_put(&entry.file, entry.old_content);
            }
            changed.push(entry.file);
        }
        Ok(changed)
    }

    pub fn log(&self) -> &VecDeque<EditLogEntry> { &self.edit_log }

    pub fn version(&self, relative_path: &str) -> Option<FileVersion> {
        self.versions.get(relative_path).copied()
    }

    /// List files matching a glob pattern relative to project root.
    /// Uses manual directory walking (no external glob crate in v0.1).
    pub fn glob(&self, pattern: &str) -> Result<Vec<String>, Error> {
        // Walk project root recursively.
        // Support patterns:
        //   "**/*" or "*" — all files
        //   "dir/**/*" or "dir/*" — all files under dir/
        //   "**/*.ext" — all files with extension .ext
        //   "dir/**/*.ext" — files under dir/ with extension .ext
        // Every result goes through safe_resolve to catch symlinks outside root.
        let mut results = Vec::new();
        self.walk_dir(&self.root, &self.root, &mut results)?;

        // Parse the pattern into (prefix, extension_filter)
        let (prefix, ext_filter) = Self::parse_glob_pattern(pattern);

        let filtered = results.into_iter().filter(|path| {
            // Prefix filter: if pattern starts with "dir/", only match files under dir/
            if !prefix.is_empty() && !path.starts_with(&prefix) {
                return false;
            }
            // Extension filter: if pattern ends with "*.ext", only match that extension
            if let Some(ref ext) = ext_filter {
                if !path.ends_with(ext) {
                    return false;
                }
            }
            true
        }).collect();

        Ok(filtered)
    }

    /// Parse a glob pattern into (directory_prefix, optional_extension_filter).
    /// Examples:
    ///   "**/*"         → ("", None)
    ///   "src/**/*.rs"  → ("src/", Some(".rs"))
    ///   "**/*.py"      → ("", Some(".py"))
    ///   "lib/*"        → ("lib/", None)
    fn parse_glob_pattern(pattern: &str) -> (String, Option<String>) {
        let stripped = pattern.trim_end();

        // Extract directory prefix (everything before the first wildcard)
        let prefix = if let Some(star_pos) = stripped.find('*') {
            let prefix_part = &stripped[..star_pos];
            // Normalize: ensure it ends with / if non-empty
            if prefix_part.is_empty() {
                String::new()
            } else if prefix_part.ends_with('/') {
                prefix_part.to_string()
            } else {
                // e.g., "src*" → treat "src" as prefix
                prefix_part.to_string()
            }
        } else {
            // No wildcard — treat entire pattern as a prefix
            stripped.to_string()
        };

        // Extract extension filter (if pattern ends with *.ext)
        let ext_filter = if let Some(last_star) = stripped.rfind('*') {
            let after_star = &stripped[last_star + 1..];
            if after_star.starts_with('.') && !after_star.contains('/') {
                Some(after_star.to_string())  // e.g., ".rs", ".py"
            } else {
                None
            }
        } else {
            None
        };

        (prefix, ext_filter)
    }

    fn walk_dir(&self, dir: &Path, root: &Path, results: &mut Vec<String>) -> Result<(), Error> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            // Skip hidden files/dirs and common noise
            if entry.file_name().to_str().map_or(true, |n| n.starts_with('.')) {
                continue;
            }
            if path.is_dir() {
                self.walk_dir(&path, root, results)?;
            } else if path.is_file() {
                // Verify under root (catches symlinks)
                let canonical = path.canonicalize()?;
                let root_canonical = root.canonicalize()?;
                if canonical.starts_with(&root_canonical) {
                    if let Ok(rel) = path.strip_prefix(root) {
                        results.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
        Ok(())
    }

    /// Resolve a target string to file paths.
    /// "@" prefix → not a file, caller should resolve as anchor
    /// Directory → all files recursively
    /// Contains "*" → glob
    /// Otherwise → single file
    pub fn resolve_target(&self, target: &str) -> Result<Vec<String>, Error> {
        if target.starts_with('@') {
            return Err(Error::IsAnchorId(target.to_string()));
        }
        let abs = self.safe_resolve(target)?;
        if abs.is_dir() {
            let mut results = Vec::new();
            self.walk_dir(&abs, &self.root, &mut results)?;
            Ok(results)
        } else if target.contains('*') {
            self.glob(target)
        } else {
            Ok(vec![target.to_string()])
        }
    }

    // ─── LRU cache (manual, no external crate) ────────────

    fn cache_put(&mut self, key: &str, value: String) {
        if self.cache_map.contains_key(key) {
            // Move to back of recency list
            self.cache_order.retain(|k| k != key);
        } else if self.cache_map.len() >= MAX_CACHED_FILES {
            // Evict least recently used
            if let Some(evicted) = self.cache_order.pop_front() {
                self.cache_map.remove(&evicted);
            }
        }
        self.cache_map.insert(key.to_string(), value);
        self.cache_order.push_back(key.to_string());
    }

    fn cache_get(&mut self, key: &str) -> Option<&String> {
        if self.cache_map.contains_key(key) {
            self.cache_order.retain(|k| k != key);
            self.cache_order.push_back(key.to_string());
            self.cache_map.get(key)
        } else {
            None
        }
    }

    // ─── Path safety ───────────────────────────────────────

    /// Resolve for reading. Path must exist and be under root.
    fn safe_resolve(&self, relative_path: &str) -> Result<PathBuf, Error> {
        let joined = self.root.join(relative_path);
        let canonical = joined.canonicalize()
            .map_err(|_| Error::PathNotFound(relative_path.to_string()))?;
        let root_canonical = self.root.canonicalize()
            .map_err(|e| Error::InternalError(format!("Cannot canonicalize root: {}", e)))?;
        if !canonical.starts_with(&root_canonical) {
            return Err(Error::PathTraversal(relative_path.to_string()));
        }
        Ok(canonical)
    }

    /// Resolve for writing. The file may not exist yet, but the parent directory must
    /// exist and be under root.
    fn safe_resolve_for_write(&self, relative_path: &str) -> Result<PathBuf, Error> {
        let joined = self.root.join(relative_path);

        // Check for obvious traversal attempts in the path itself
        if relative_path.contains("..") {
            return Err(Error::PathTraversal(relative_path.to_string()));
        }

        // If the file already exists, use normal safe_resolve
        if joined.exists() {
            return self.safe_resolve(relative_path);
        }

        // File doesn't exist yet: verify the parent directory is under root
        let parent = joined.parent()
            .ok_or(Error::PathNotFound(relative_path.to_string()))?;
        let parent_canonical = parent.canonicalize()
            .map_err(|_| Error::PathNotFound(format!("Parent directory of {}", relative_path)))?;
        let root_canonical = self.root.canonicalize()
            .map_err(|e| Error::InternalError(format!("Cannot canonicalize root: {}", e)))?;

        if !parent_canonical.starts_with(&root_canonical) {
            return Err(Error::PathTraversal(relative_path.to_string()));
        }

        // Return the non-canonical path (file will be created)
        Ok(parent_canonical.join(joined.file_name().unwrap()))
    }
}

/// Atomic write with post-persist root verification.
/// The root check after persist() closes the TOCTOU window in safe_resolve_for_write:
/// even if an attacker replaces the parent dir with a symlink between validation and
/// persist, we detect the escape and delete the file.
fn atomic_write(path: &Path, content: &str, root: &Path) -> Result<(), std::io::Error> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(content.as_bytes())?;
    tmp.flush()?;
    tmp.persist(path).map_err(|e| e.error)?;

    // Post-persist verification: confirm the file is still under root
    if let Ok(canonical) = path.canonicalize() {
        if let Ok(root_canonical) = root.canonicalize() {
            if !canonical.starts_with(&root_canonical) {
                // Escape detected! Remove the ACTUAL file at the canonical path,
                // not just the symlink. remove_file(path) would only remove the
                // symlink, leaving the content at the escaped target.
                let _ = std::fs::remove_file(&canonical);
                // Also remove the symlink itself if it still exists
                let _ = std::fs::remove_file(path);
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Write target escaped project root (possible symlink race)"
                ));
            }
        }
    }
    Ok(())
}
```

### Tests

```
test_path_traversal_blocked:
    fm = FileManager::new(temp_dir)
    assert fm.read("../../../etc/passwd").is_err()
    assert matches error to PathTraversal

test_path_traversal_via_dotdot:
    fm.read("subdir/../../etc/passwd") → Error::PathTraversal

test_symlink_outside_root:
    create symlink temp_dir/link → /etc/
    assert fm.read("link/passwd").is_err()

test_write_new_file:
    fm.write("new_file.txt", "hello") → succeeds
    fm.read("new_file.txt") → ("hello", _)

test_write_new_file_traversal:
    fm.write("../outside.txt", "evil") → Error::PathTraversal

test_read_version_tracking:
    write "hello" to file
    (_, v1) = fm.read("test.txt")
    assert v1 >= 1
    fm.write("test.txt", "world")
    (_, v2) = fm.read("test.txt")
    assert v2 == v1 + 1

test_external_change_detection:
    fm.read("test.txt")  // caches "hello"
    std::fs::write(abs_path, "changed")  // external edit
    (content, v) = fm.read("test.txt")
    assert content == "changed"
    assert version incremented

test_snapshot_captures_disk_state:
    // Snapshot reads from disk, not just cache
    fm.write("a.txt", "a")
    fm.read("b.txt")  // b.txt exists on disk with different content
    fm.snapshot("s1")
    // Verify snapshot has disk content of both files
    // (not stale cache content)

test_snapshot_restore:
    fm.write("test.txt", "v1")
    fm.snapshot("s1")
    fm.write("test.txt", "v2")
    fm.restore("s1")
    (content, _) = fm.read("test.txt")
    assert content == "v1"

test_snapshot_deletes_new_files:
    fm.write("a.txt", "a")
    fm.snapshot("s1")
    fm.write("b.txt", "b")   // new file after snapshot
    fm.restore("s1")
    assert fm.read("b.txt").is_err()  // b.txt deleted

test_snapshot_limit:
    create 11 snapshots
    assert fm.snapshots.len() <= MAX_SNAPSHOTS

test_undo:
    fm.write("test.txt", "v1")
    fm.write("test.txt", "v2")
    fm.write("test.txt", "v3")
    fm.undo(2)
    (content, _) = fm.read("test.txt")
    assert content == "v1"

test_undo_is_not_logged:
    fm.write("test.txt", "v1")
    fm.write("test.txt", "v2")
    assert fm.log().len() == 2
    fm.undo(1)
    assert fm.log().len() == 1  // entry was popped, not a new entry added

test_edit_log_bounded_by_count:
    for i in 0..300:
        fm.write("test.txt", &format!("v{}", i))
    assert fm.log().len() <= MAX_EDIT_LOG_ENTRIES

test_edit_log_bounded_by_bytes:
    // Write a 1MB file 100 times — should trigger byte budget eviction
    let big = "x".repeat(1_000_000);
    for _ in 0..100:
        fm.write("big.txt", &big)
    assert fm.edit_log_bytes <= MAX_EDIT_LOG_BYTES + big.len() * 2

test_edit_range:
    fm.write("test.txt", "hello world")
    fm.edit_range("test.txt", 6..11, "rust")
    (content, _) = fm.read("test.txt")
    assert content == "hello rust"

test_edit_range_out_of_bounds:
    fm.write("test.txt", "short")
    assert fm.edit_range("test.txt", 0..100, "x").is_err()

test_lru_cache_eviction:
    // Write MAX_CACHED_FILES + 1 different files
    // First file should be evicted from cache
    // But re-reading it should work (reads from disk)

test_glob_all_files:
    fm.write("src/main.rs", "fn main() {}")
    fm.write("src/lib.rs", "pub mod foo;")
    fm.write("README.md", "# Hello")
    let all = fm.glob("**/*").unwrap()
    assert all.contains(&"src/main.rs".to_string())
    assert all.contains(&"README.md".to_string())

test_glob_extension_filter:
    fm.write("src/main.rs", "fn main() {}")
    fm.write("src/lib.rs", "pub mod foo;")
    fm.write("README.md", "# Hello")
    let rs_files = fm.glob("**/*.rs").unwrap()
    assert rs_files.contains(&"src/main.rs".to_string())
    assert !rs_files.contains(&"README.md".to_string())

test_glob_prefix_filter:
    fm.write("src/main.rs", "fn main() {}")
    fm.write("tests/test1.rs", "fn test() {}")
    let src_files = fm.glob("src/**/*").unwrap()
    assert src_files.contains(&"src/main.rs".to_string())
    assert !src_files.contains(&"tests/test1.rs".to_string())

test_glob_prefix_and_extension:
    fm.write("src/main.rs", "fn main() {}")
    fm.write("src/config.toml", "[package]")
    fm.write("tests/test1.rs", "fn test() {}")
    let result = fm.glob("src/**/*.rs").unwrap()
    assert result == vec!["src/main.rs".to_string()]

test_file_too_large:
    // Create a file larger than MAX_FILE_SIZE on disk
    let big = "x".repeat(MAX_FILE_SIZE + 1);
    std::fs::write(root.join("huge.txt"), &big).unwrap();
    fm.known_files.insert("huge.txt".to_string());
    assert matches!(fm.read("huge.txt"), Err(Error::FileTooLarge(..)));

test_undo_cas_conflict:
    fm.write("test.txt", "v1")
    fm.write("test.txt", "v2")
    // Simulate external modification
    std::fs::write(root.join("test.txt"), "externally_modified").unwrap();
    assert matches!(fm.undo(1), Err(Error::CasConflict { .. }));

test_restore_logs_deletions_for_undo:
    fm.write("original.txt", "keep me")
    fm.snapshot("before")
    fm.write("new_file.txt", "created after snapshot")
    fm.restore("before")
    // new_file.txt should be deleted
    assert !root.join("new_file.txt").exists()
    // But undo should bring it back
    fm.undo(1)  // undoes the deletion
    assert root.join("new_file.txt").exists()
    let (content, _) = fm.read("new_file.txt").unwrap()
    assert content == "created after snapshot"

test_strip_comments_nested:
    // Python function with comment inside nested block
    let code = "def foo():\n    if True:\n        # nested comment\n        x = 1\n    return x\n"
    // Parse with tree-sitter, get function node
    // strip_comments should remove "# nested comment" even though it's 2 levels deep
    let stripped = config.strip_comments(&func_node, code.as_bytes())
    assert !stripped.contains("# nested comment")
    assert stripped.contains("x = 1")

test_atomic_write_symlink_race:
    // Create a symlink pointing outside root AFTER safe_resolve_for_write
    // atomic_write's post-persist check should catch this
    // (Hard to test without race conditions; use a symlinked directory)
    let outside = tempdir().unwrap();
    let attack_path = root.join("escape");
    std::os::unix::fs::symlink(outside.path(), &attack_path).unwrap();
    assert fm.write("escape/evil.txt", "pwned").is_err()
    assert !outside.path().join("evil.txt").exists()
```


---

## 7. Module 4: Structural Indexer

**File:** `src/indexer.rs`  
**Dependencies:** `types.rs`, `simhash.rs`, `lang/*`

### Interface

```rust
pub struct FileIndex {
    pub file: String,
    pub version: FileVersion,
    pub nodes: Vec<IndexedNode>,
    pub structural_map: HashMap<String, Vec<usize>>,  // path → node indices
}

#[derive(Debug, Clone)]
pub struct IndexedNode {
    pub structural_path: String,
    pub kind: NodeKind,
    pub name: Option<String>,
    pub byte_range: Range<usize>,
    pub line_start: usize,           // 1-indexed
    pub line_end: usize,             // 1-indexed
    pub simhash: SimHashValue,
    pub ordinal: usize,              // 0-indexed
    pub ordinal_context: String,
    pub parent_index: Option<usize>, // index into nodes vec
    pub depth: usize,
}

pub struct Indexer {
    registry: LanguageRegistry,
}

impl Indexer {
    pub fn new(registry: LanguageRegistry) -> Self;

    /// Index a file. Dispatches to tree-sitter or fallback.
    pub fn index(&self, path: &str, content: &str, version: FileVersion) -> FileIndex;
}
```

### Helper: ordinal_to_human

```rust
/// Convert ordinal number to human-readable string: 1 → "1st", 2 → "2nd", etc.
/// Correctly handles 11th/12th/13th and 21st/22nd/23rd.
fn ordinal_to_human(n: usize) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",  // special case: 11th, 12th, 13th
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{}{}", n, suffix)
}

/// Convert a CodeNodeKind to a human-readable label for ordinal_context.
fn kind_to_label(kind: &CodeNodeKind) -> &'static str {
    match kind {
        CodeNodeKind::Function => "function",
        CodeNodeKind::Method => "method",
        CodeNodeKind::Class => "class",
        CodeNodeKind::Module => "module",
        CodeNodeKind::Block => "block",
        CodeNodeKind::Import => "import",
    }
}
```

### Algorithm: tree-sitter path

```
fn index_treesitter(path, content, version, config):
    parser = tree_sitter::Parser::new()
    parser.set_language(config.language())
    tree = parser.parse(content, None)
    root = tree.root_node()

    // PASS 1: collect anchorable nodes with positions and names
    let mut nodes: Vec<IndexedNode> = Vec::new()
    walk_collect(root, config, content, path, &mut nodes, None, 0)

    // PASS 2: assign parent indices (two-pass so children know their parent's index)
    // After pass 1, each node has parent_index set to the index of its
    // nearest anchorable ancestor in the nodes vec. This happens during
    // walk_collect: we pass the current node's index as parent to children.

    // Build structural map
    let structural_map = build_structural_map(&nodes)

    FileIndex { file: path.to_string(), version, nodes, structural_map }

fn walk_collect(node, config, source, file_path, nodes, parent_index, depth):
    if config.is_anchorable(&node):
        let name = config.extract_name(&node, source)
        let kind = config.node_kind(&node)

        // Build structural path by walking ancestors
        let path = build_structural_path(&node, config, source, file_path)

        // SimHash
        let code_text = config.strip_comments(&node, source)
        let hash = simhash(&code_text, true)

        // Ordinal: count preceding siblings of same node kind
        let ordinal = count_preceding_siblings_of_same_kind(&node)
        let parent_name = parent_index
            .and_then(|i| nodes[i].name.as_deref())
            .unwrap_or(file_path);
        let ordinal_context = format!(
            "{} {} in {}",
            ordinal_to_human(ordinal),  // "1st", "2nd", etc.
            kind_to_label(&kind),        // "method", "function", "block", etc.
            parent_name
        )

        let my_index = nodes.len()
        nodes.push(IndexedNode {
            structural_path: path,
            kind, name,
            byte_range: node.start_byte()..node.end_byte(),
            line_start: node.start_position().row + 1,
            line_end: node.end_position().row + 1,
            simhash: hash,
            ordinal,
            ordinal_context,
            parent_index,
            depth,
        })

        // Recurse with my_index as parent
        let mut cursor = node.walk();
        for child in node.children(&mut cursor):
            walk_collect(child, config, source, file_path, nodes, Some(my_index), depth + 1)
    else:
        // Not anchorable — recurse with same parent
        let mut cursor = node.walk();
        for child in node.children(&mut cursor):
            walk_collect(child, config, source, file_path, nodes, parent_index, depth)

fn build_structural_path(node, config, source, file_path) -> String:
    let mut parts: Vec<String> = Vec::new()
    let mut current = Some(*node)
    while let Some(n) = current:
        if config.is_anchorable(&n):
            match config.extract_name(&n, source):
                Some(name) => parts.push(name),
                None => {
                    // Anonymous structural node: _if[2], _for[0], etc.
                    let ord = count_preceding_siblings_of_same_kind(&n);
                    parts.push(format!("_{}[{}]", n.kind(), ord))
                }
        current = n.parent()
    parts.reverse()
    // Remove first element if it's "module" (we use file path instead)
    if parts.first().map_or(false, |p| p == "module") {
        parts.remove(0);
    }
    let module = file_path_to_module(file_path)
    format!("{}:{}", module, parts.join("."))
```

### Algorithm: fallback path

```
fn index_fallback(path, content, version):
    let paragraphs = FallbackConfig::split_paragraphs(content)
    let module = file_path_to_module(path)
    let mut nodes = Vec::new()

    for (i, range) in paragraphs.iter().enumerate():
        let text = &content[range.clone()]
        let hash = simhash(text, true)
        let line_start = content[..range.start].matches('\n').count() + 1
        let line_end = content[..range.end].matches('\n').count() + 1

        nodes.push(IndexedNode {
            structural_path: format!("{}:_para[{}]", module, i),
            kind: NodeKind::Text(TextNodeKind::Paragraph),
            name: None,
            byte_range: range.clone(),
            line_start,
            line_end,
            simhash: hash,
            ordinal: i,
            ordinal_context: format!("{} paragraph", ordinal_to_human(i)),
            parent_index: None,
            depth: 0,
        })

    let structural_map = build_structural_map(&nodes)
    FileIndex { file: path.to_string(), version, nodes, structural_map }
```

### Tests

```
test_python_class_with_methods:
    content = fixture("python/session.py")
    index = indexer.index("python/session.py", content, 1)

    // Must find: SessionManager class, all its methods, TokenStore class, all its methods
    assert index.nodes.iter().any(|n| n.structural_path.ends_with(":SessionManager"))
    assert index.nodes.iter().any(|n| n.structural_path.ends_with(":SessionManager.validate_token"))
    assert index.nodes.iter().any(|n| n.structural_path.ends_with(":SessionManager.__init__"))
    assert index.nodes.iter().any(|n| n.structural_path.ends_with(":TokenStore"))

    // validate_token should be a Method, not Function
    let vt = index.nodes.iter().find(|n| n.name.as_deref() == Some("validate_token")).unwrap();
    assert matches!(vt.kind, NodeKind::Code(CodeNodeKind::Method))

    // ordinals
    let methods: Vec<_> = index.nodes.iter()
        .filter(|n| matches!(n.kind, NodeKind::Code(CodeNodeKind::Method))
                && n.structural_path.contains("SessionManager"))
        .collect();
    assert methods[0].ordinal == 0  // __init__
    assert methods[1].ordinal == 1  // create_token

test_python_nested_function:
    content = "def outer():\n    def inner():\n        pass"
    index = indexer.index("test.py", content, 1)
    assert paths contain "test:outer" and "test:outer.inner"
    let inner = find_by_name(&index, "inner");
    assert inner.parent_index.is_some()
    assert index.nodes[inner.parent_index.unwrap()].name.as_deref() == Some("outer")

test_python_anonymous_blocks:
    content = "def foo():\n    if True:\n        pass\n    if False:\n        pass"
    index = indexer.index("test.py", content, 1)
    // Two if blocks: _if_statement[0] and _if_statement[1]
    assert paths contain "test:foo._if_statement[0]" and "test:foo._if_statement[1]"

test_fallback_paragraphs:
    content = "first\nstill first\n\nsecond\n\nthird"
    index = indexer.index("notes.txt", content, 1)
    assert index.nodes.len() == 3
    assert index.nodes[0].structural_path == "notes:_para[0]"
    assert index.nodes[1].structural_path == "notes:_para[1]"
    assert index.nodes[2].structural_path == "notes:_para[2]"

test_simhash_populated:
    index = indexer.index("test.py", "def foo(): return 1", 1)
    assert index.nodes.iter().all(|n| n.simhash != 0 || n.kind == NodeKind::Code(CodeNodeKind::Module))

test_structural_map:
    index = indexer.index("python/session.py", fixture_content, 1)
    let key = /* path for validate_token */;
    assert index.structural_map.contains_key(key)
    assert index.structural_map[key].len() == 1

test_empty_file:
    index = indexer.index("empty.py", "", 1)
    // Should produce a module node and nothing else (or just be empty)
    // Must not panic.

test_unicode_content:
    content = "def café():\n    return '日本語'"
    index = indexer.index("test.py", content, 1)
    assert index.nodes.iter().any(|n| n.name.as_deref() == Some("café"))
    // Must not panic, byte ranges must be valid UTF-8 boundaries
```


---

## 8. Module 5: Anchor Store

**File:** `src/anchor_store.rs`  
**Dependencies:** `types.rs`

### Interface

```rust
const MAX_ANCHORS: usize = 10_000;
const MAX_ANCHORS_PER_FILE: usize = 500;  // prevent single OBSERVE from dominating the store
const GC_MAX_AGE: usize = 100;            // turns

pub struct AnchorStore {
    anchors: HashMap<AnchorId, Anchor>,
    last_access: HashMap<AnchorId, usize>,
    per_file_count: HashMap<String, usize>,  // file → number of anchors stored
    current_turn: usize,
    id_counter: u64,  // monotonic counter for fallback ID generation (never decremented)
}

impl AnchorStore {
    pub fn new() -> Self;

    /// Store an anchor with a generated id. Returns the id.
    /// Enforces per-file cap (MAX_ANCHORS_PER_FILE) and global cap (MAX_ANCHORS).
    /// If per-file cap is hit, evicts oldest anchors for that file.
    pub fn store(&mut self, anchor: Anchor) -> AnchorId {
        // Per-file cap
        let file = anchor.file.clone();
        let file_count = *self.per_file_count.get(&file).unwrap_or(&0);
        if file_count >= MAX_ANCHORS_PER_FILE {
            self.evict_oldest_for_file(&file);
        }

        // Global cap
        if self.anchors.len() >= MAX_ANCHORS {
            self.gc(GC_MAX_AGE);
        }
        if self.anchors.len() >= MAX_ANCHORS {
            self.evict_oldest();
        }

        let id = self.generate_id();
        let anchor = Anchor { id: id.clone(), ..anchor };
        self.anchors.insert(id.clone(), anchor);
        self.last_access.insert(id.clone(), self.current_turn);
        *self.per_file_count.entry(file).or_insert(0) += 1;
        id
    }

    /// Evict the least recently accessed anchor globally.
    fn evict_oldest(&mut self) {
        if let Some((id, _)) = self.last_access.iter().min_by_key(|(_, &turn)| turn) {
            let id = id.clone();
            if let Some(anchor) = self.anchors.remove(&id) {
                if let Some(count) = self.per_file_count.get_mut(&anchor.file) {
                    *count = count.saturating_sub(1);
                }
            }
            self.last_access.remove(&id);
        }
    }

    /// Evict the least recently accessed anchor for a specific file.
    fn evict_oldest_for_file(&mut self, file: &str) {
        let oldest = self.anchors.iter()
            .filter(|(_, a)| a.file == file)
            .min_by_key(|(id, _)| self.last_access.get(*id).copied().unwrap_or(0))
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            self.anchors.remove(&id);
            self.last_access.remove(&id);
            if let Some(count) = self.per_file_count.get_mut(file) {
                *count = count.saturating_sub(1);
            }
        }
    }

    /// Update an existing anchor (for refresh after resolution).
    pub fn update(&mut self, id: &str, anchor: Anchor) {
        self.anchors.insert(id.to_string(), anchor);
        self.last_access.insert(id.to_string(), self.current_turn);
    }

    /// Look up by id. Updates last_access.
    pub fn get(&mut self, id: &str) -> Option<&Anchor> {
        if self.anchors.contains_key(id) {
            self.last_access.insert(id.to_string(), self.current_turn);
        }
        self.anchors.get(id)
    }

    /// Look up by id WITHOUT updating last_access (for staleness checks).
    pub fn peek(&self, id: &str) -> Option<&Anchor>;

    /// All anchors for a file.
    pub fn find_by_file(&self, file: &str) -> Vec<&Anchor>;

    /// Advance turn counter. Call once per tool call.
    pub fn advance_turn(&mut self) { self.current_turn += 1; }

    /// Current turn.
    pub fn current_turn(&self) -> usize { self.current_turn }

    /// Garbage collect anchors not accessed in `max_age` turns.
    pub fn gc(&mut self, max_age: usize) {
        let cutoff = self.current_turn.saturating_sub(max_age);
        // On early turns (< max_age), cutoff is 0, so nothing gets evicted. This is
        // correct: we don't want to GC anchors that were just created.
        let to_remove: Vec<AnchorId> = self.last_access.iter()
            .filter(|(_, &turn)| turn < cutoff)
            .map(|(id, _)| id.clone())
            .collect();
        for id in to_remove {
            if let Some(anchor) = self.anchors.remove(&id) {
                if let Some(count) = self.per_file_count.get_mut(&anchor.file) {
                    *count = count.saturating_sub(1);
                }
            }
            self.last_access.remove(&id);
        }
    }

    /// Invalidate all anchors for a file (don't delete, just mark stale
    /// by setting version to 0 so resolver knows they need re-resolution).
    pub fn invalidate_file(&mut self, file: &str) {
        for anchor in self.anchors.values_mut() {
            if anchor.file == file {
                anchor.contextual.version = 0;
            }
        }
    }

    /// Remove all anchors for a file (used on snapshot restore).
    pub fn remove_file(&mut self, file: &str) {
        let to_remove: Vec<AnchorId> = self.anchors.iter()
            .filter(|(_, a)| a.file == file)
            .map(|(id, _)| id.clone())
            .collect();
        for id in to_remove {
            self.anchors.remove(&id);
            self.last_access.remove(&id);
        }
        self.per_file_count.remove(file);
    }

    pub fn len(&self) -> usize { self.anchors.len() }
}
```

### Anchor ID Generation

```rust
/// Format: "@a_" + 4 hex chars. "@" prefix prevents ambiguity with file names like a_config.py.
/// Examples: "@a_7f3c", "@a_0b2e"
fn generate_id(&mut self) -> AnchorId {
    for _ in 0..1000 {
        let n: u16 = rand::random();
        let id = format!("@a_{:04x}", n);
        if !self.anchors.contains_key(&id) {
            return id;
        }
    }
    // Fallback: use a monotonic counter that never repeats, even after GC
    loop {
        self.id_counter += 1;
        let id = format!("@a_x{:05}", self.id_counter);
        if !self.anchors.contains_key(&id) {
            return id;
        }
    }
}
```

### Tests

```
test_store_and_get:
    let anchor = make_test_anchor("test.py", "test:Foo.bar")
    let id = store.store(anchor)
    assert id.starts_with("@a_")
    assert store.get(&id).is_some()
    assert store.get(&id).unwrap().structural.path == "test:Foo.bar"

test_get_nonexistent:
    assert store.get("@a_9999").is_none()

test_find_by_file:
    store anchor for "a.py" and "b.py"
    assert store.find_by_file("a.py").len() == 1
    assert store.find_by_file("b.py").len() == 1
    assert store.find_by_file("c.py").len() == 0

test_gc_removes_old:
    let id = store.store(make_test_anchor(...))
    for _ in 0..150: store.advance_turn()
    store.gc(100)
    assert store.get(&id).is_none()  // last accessed 150 turns ago

test_gc_preserves_recently_accessed:
    let id = store.store(make_test_anchor(...))
    for _ in 0..50: store.advance_turn()
    store.get(&id)  // refresh access
    for _ in 0..50: store.advance_turn()
    store.gc(100)
    assert store.get(&id).is_some()  // last accessed 50 turns ago, within window

test_hard_cap:
    for _ in 0..MAX_ANCHORS + 100:
        store.store(make_test_anchor(...))
    assert store.len() <= MAX_ANCHORS

test_invalidate_file:
    let id = store.store(make_test_anchor("test.py", "test:Foo"))
    store.invalidate_file("test.py")
    let anchor = store.peek(&id).unwrap()
    assert anchor.contextual.version == 0  // marked stale

test_remove_file:
    let id = store.store(make_test_anchor("test.py", "test:Foo"))
    store.remove_file("test.py")
    assert store.get(&id).is_none()

test_gc_on_deleted_anchor:
    let id = store.store(make_test_anchor(...))
    store.remove_file("test.py")
    // Trying to use a GC'd/removed anchor should return None
    assert store.get(&id).is_none()

test_generate_id_fallback_counter:
    // Directly exercise the counter fallback by pre-filling all possible random IDs.
    // generate_id tries random u16 values formatted as "@a_{:04x}".
    // Pre-insert all 65536 of them so random always collides.
    let mut store = AnchorStore::new();
    for i in 0..=u16::MAX {
        let id = format!("@a_{:04x}", i);
        store.anchors.insert(id, make_test_anchor("fill.py", "fill:X"));
    }
    // Now generate_id MUST fall through to the counter path
    let id1 = store.generate_id();
    assert id1.starts_with("@a_x");  // counter-based format
    let id2 = store.generate_id();
    assert id2.starts_with("@a_x");
    assert id1 != id2;  // monotonic counter ensures uniqueness

test_generate_id_counter_survives_gc:
    // Verify that GC doesn't reset the counter, preventing re-use of fallback IDs
    let mut store = AnchorStore::new();
    // Force a counter-based ID
    for i in 0..=u16::MAX {
        store.anchors.insert(format!("@a_{:04x}", i), make_test_anchor("fill.py", "fill:X"));
    }
    let id1 = store.generate_id();
    let counter_after_first = store.id_counter;
    // Now GC everything
    store.anchors.clear();
    store.last_access.clear();
    // Generate another — counter should continue from where it left off
    // (random will succeed now, but if forced again it must not collide)
    for i in 0..=u16::MAX {
        store.anchors.insert(format!("@a_{:04x}", i), make_test_anchor("fill.py", "fill:X"));
    }
    // Also block the first counter-based ID to prove counter didn't reset
    store.anchors.insert(id1.clone(), make_test_anchor("fill.py", "fill:X"));
    let id2 = store.generate_id();
    assert id2.starts_with("@a_x");
    assert id2 != id1;
    assert store.id_counter > counter_after_first;
```


---

## 9. Module 6: Resolution Engine

**File:** `src/resolver.rs`  
**Dependencies:** `types.rs`, `simhash.rs`, `indexer.rs`, `anchor_store.rs`, `file_manager.rs`

### Interface

```rust
pub struct Resolver {
    /// Cache of file indices. Manual LRU: HashMap for lookup + VecDeque for recency.
    /// Bounded to MAX_CACHED_FILES. Evicts least recently used on overflow.
    index_cache: HashMap<String, (FileVersion, FileIndex)>,
    index_cache_order: VecDeque<String>,  // most recently used at back
}

impl Resolver {
    pub fn new() -> Self;

    /// Core function: resolve an anchor id to a byte range.
    pub fn resolve(
        &mut self,
        anchor_id: &str,
        store: &mut AnchorStore,
        file_manager: &mut FileManager,
        indexer: &Indexer,
    ) -> Result<ResolvedAnchor, ToolError>;

    /// Cheap staleness check (no re-indexing).
    pub fn staleness_hint(
        &self,
        anchor_id: &str,
        store: &AnchorStore,
        file_manager: &FileManager,
    ) -> StalenessHint;
}
```

### `get_or_rebuild_index`

```rust
fn get_or_rebuild_index(
    &mut self,
    file: &str,
    content: &str,
    current_version: FileVersion,
    indexer: &Indexer,
) -> &FileIndex {
    // Check cache: hit if present and version matches
    if let Some((cached_version, _)) = self.index_cache.get(file) {
        if *cached_version == current_version {
            // LRU touch: move to back of recency list
            self.index_cache_order.retain(|k| k != file);
            self.index_cache_order.push_back(file.to_string());
            return &self.index_cache.get(file).unwrap().1;
        }
    }

    // Cache miss or stale: rebuild
    let index = indexer.index(file, content, current_version);

    // Enforce cache limit — evict LRU (front of deque)
    if self.index_cache.len() >= MAX_CACHED_FILES {
        if let Some(evicted) = self.index_cache_order.pop_front() {
            self.index_cache.remove(&evicted);
        }
    }

    // Remove old entry from recency list if updating
    self.index_cache_order.retain(|k| k != file);
    self.index_cache_order.push_back(file.to_string());
    self.index_cache.insert(file.to_string(), (current_version, index));
    &self.index_cache.get(file).unwrap().1
}
```

### Resolution Algorithm

```
fn resolve(anchor_id, store, file_manager, indexer):
    // 1. Look up anchor
    let anchor = store.get(anchor_id)
        .ok_or(ToolError {
            kind: "RESOLUTION_FAILED",
            message: format!("Anchor {} not found. It may have been garbage collected.", anchor_id),
            anchor: Some(anchor_id.to_string()),
            candidates: vec![],
            suggestion: "Re-OBSERVE the target file to get fresh anchors.".into(),
        })?
        .clone();  // clone to release borrow on store

    // 2. Read current file
    let (content, current_version) = file_manager.read(&anchor.file)?;

    // 3. FAST PATH: version matches
    if anchor.contextual.version == current_version {
        // Validate byte range is still in bounds
        if anchor.positional.byte_end <= content.len() {
            return Ok(ResolvedAnchor {
                anchor: anchor.clone(),
                byte_range: anchor.positional.byte_start..anchor.positional.byte_end,
                confidence: 1.0,
                warnings: vec![],
            });
        }
        // If byte range is out of bounds, fall through to stale path
    }

    // 4. STALE PATH: re-index and search
    let file_index = self.get_or_rebuild_index(&anchor.file, &content, current_version, indexer);

    // 5. Score candidates
    let mut candidates: Vec<(usize, f64, u32)> = Vec::new();  // (node_idx, score, hamming_dist)

    // 5a. Structural match
    if let Some(node_indices) = file_index.structural_map.get(&anchor.structural.path) {
        for &idx in node_indices {
            let node = &file_index.nodes[idx];
            let dist = hamming_distance(anchor.contextual.hash, node.simhash);
            let mut score = 0.5;  // structural match base
            if dist == IDENTICAL {
                score += 0.4;
            } else if dist <= SIMILAR_MAX {
                score += 0.3;
            }
            let line_diff = (node.line_start as i64 - anchor.positional.line_start as i64).unsigned_abs();
            if line_diff < 20 {
                score += 0.1;
            }
            candidates.push((idx, score, dist));
        }
    }

    // 5b. Contextual scan (find nodes with close SimHash, not already found)
    let seen: HashSet<usize> = candidates.iter().map(|(i, _, _)| *i).collect();
    for (idx, node) in file_index.nodes.iter().enumerate() {
        if seen.contains(&idx) { continue; }
        let dist = hamming_distance(anchor.contextual.hash, node.simhash);
        if dist <= SIMILAR_MAX {
            let mut score = if dist == IDENTICAL { 0.4 } else { 0.3 };
            let line_diff = (node.line_start as i64 - anchor.positional.line_start as i64).unsigned_abs();
            if line_diff < 20 {
                score += 0.1;
            }
            candidates.push((idx, score, dist));
        }
    }

    // 5c. Sort by score descending. Use total_cmp to avoid panic on NaN.
    candidates.sort_by(|a, b| b.1.total_cmp(&a.1));

    // 6. Evaluate best candidate
    if candidates.is_empty() {
        return Err(ToolError {
            kind: "RESOLUTION_FAILED",
            message: format!("No matching node found for anchor {}. The target may have been deleted.", anchor_id),
            anchor: Some(anchor_id.to_string()),
            candidates: vec![],
            suggestion: "Re-OBSERVE the file to get fresh anchors.".into(),
        });
    }

    let (best_idx, best_score, best_dist) = candidates[0];
    let best_node = &file_index.nodes[best_idx];

    if best_score < 0.5 {
        // Ambiguous — return top 3 as candidates
        let top_candidates: Vec<AnchorDisplay> = candidates.iter().take(3)
            .map(|(idx, _, _)| {
                let n = &file_index.nodes[*idx];
                AnchorDisplay {
                    id: format!("@candidate_{}", idx),
                    display: format!("{} ({:?}, L{}-{})", n.structural_path, n.kind, n.line_start, n.line_end),
                }
            })
            .collect();
        return Err(ToolError {
            kind: "AMBIGUOUS_RESOLUTION",
            message: "Multiple weak matches found. Cannot determine correct target.".into(),
            anchor: Some(anchor_id.to_string()),
            candidates: top_candidates,
            suggestion: "Re-OBSERVE the relevant area to get unambiguous anchors.".into(),
        });
    }

    // 7. Build warnings
    let mut warnings = Vec::new();
    if best_dist > IDENTICAL && best_dist <= SIMILAR_MAX {
        warnings.push(format!("Content changed slightly (SimHash distance {})", best_dist));
    }
    if best_node.structural_path != anchor.structural.path {
        warnings.push(format!("Structural path changed: {} → {}", anchor.structural.path, best_node.structural_path));
    }

    // 8. Refresh anchor in store
    let refreshed = Anchor {
        id: anchor.id.clone(),
        file: anchor.file.clone(),
        structural: StructuralInfo { path: best_node.structural_path.clone() },
        contextual: ContextualInfo { hash: best_node.simhash, version: current_version },
        positional: PositionalInfo {
            byte_start: best_node.byte_range.start,
            byte_end: best_node.byte_range.end,
            line_start: best_node.line_start,
            line_end: best_node.line_end,
            ordinal: best_node.ordinal,
            ordinal_context: best_node.ordinal_context.clone(),
        },
        kind: best_node.kind,
        parent: anchor.parent.clone(),
        created_at_version: current_version,
    };
    store.update(&anchor.id, refreshed.clone());

    Ok(ResolvedAnchor {
        anchor: refreshed,
        byte_range: best_node.byte_range.clone(),
        confidence: best_score,
        warnings,
    })
```

### CAS check (called by PATCH before applying)

```rust
pub fn check_cas(
    expected: Option<FileVersion>,
    actual: FileVersion,
    anchor_id: &str,
) -> Result<(), ToolError> {
    if let Some(expected) = expected {
        if expected != actual {
            return Err(ToolError {
                kind: "CAS_CONFLICT".into(),
                message: format!(
                    "File version mismatch: expected {}, actual {}. File has been modified {} time(s) since anchor was created.",
                    expected, actual, actual - expected
                ),
                anchor: Some(anchor_id.to_string()),
                candidates: vec![],
                suggestion: "Re-OBSERVE the file to get fresh anchors with current version.".into(),
            });
        }
    }
    Ok(())
}
```

### Tests

```
test_resolve_fresh:
    // Index a file, create anchor at version 1
    // Resolve immediately → confidence 1.0, no warnings
    let (content, v) = fm.read("session.py")?;
    let index = indexer.index("session.py", &content, v);
    let node = find_by_name(&index, "validate_token");
    let anchor = node_to_anchor(node, "session.py", v);
    let id = store.store(anchor);
    let resolved = resolver.resolve(&id, &mut store, &mut fm, &indexer)?;
    assert_eq!(resolved.confidence, 1.0);
    assert!(resolved.warnings.is_empty());

test_resolve_stale_edit_elsewhere:
    // Create anchor for validate_token
    // Edit __init__ (different method in same file)
    // Resolve validate_token → succeeds, structural match
    fm.write("session.py", &modified_content)?;
    let resolved = resolver.resolve(&id, &mut store, &mut fm, &indexer)?;
    assert!(resolved.confidence >= 0.8);

test_resolve_stale_content_changed:
    // Create anchor for validate_token
    // Modify validate_token's body slightly
    // Resolve → succeeds with warning about content change
    let resolved = resolver.resolve(&id, &mut store, &mut fm, &indexer)?;
    assert!(resolved.confidence >= 0.5);
    assert!(resolved.warnings.iter().any(|w| w.contains("changed")));

test_resolve_deleted:
    // Create anchor for validate_token
    // Delete validate_token from file
    // Resolve → RESOLUTION_FAILED error
    let err = resolver.resolve(&id, &mut store, &mut fm, &indexer).unwrap_err();
    assert_eq!(err.kind, "RESOLUTION_FAILED");

test_resolve_gc_anchor:
    // Store anchor, GC it, try to resolve → clear error
    store.gc(0);  // GC everything
    let err = resolver.resolve(&id, &mut store, &mut fm, &indexer).unwrap_err();
    assert_eq!(err.kind, "RESOLUTION_FAILED");
    assert!(err.message.contains("garbage collected"));

test_cas_match:
    check_cas(Some(5), 5, "@a_test") → Ok

test_cas_mismatch:
    check_cas(Some(5), 8, "@a_test") → Err with kind "CAS_CONFLICT"

test_index_cache_invalidation:
    // Resolve at version 1 (populates cache)
    // Write new content (version 2)
    // Resolve again (should rebuild index, not use stale cache)
    let resolved1 = resolver.resolve(&id, ...)?;
    fm.write("session.py", &new_content)?;
    let resolved2 = resolver.resolve(&id, ...)?;
    // resolved2 should have updated byte range, not the old one
```


---

## 10. Module 7: Tool Handlers

**File:** `src/tools/mod.rs` + one file per tool  
**Dependencies:** all previous modules

### Ownership pattern

All mutable state lives in `ScaState`. Tool handlers take `&mut ScaState`.

```rust
// src/lib.rs

pub struct ScaState {
    pub file_manager: FileManager,
    pub indexer: Indexer,
    pub anchor_store: AnchorStore,
    pub resolver: Resolver,
}

impl ScaState {
    pub fn new(root: PathBuf) -> Result<Self, Error> {
        Ok(Self {
            file_manager: FileManager::new(root)?,
            indexer: Indexer::new(LanguageRegistry::new()),
            anchor_store: AnchorStore::new(),
            resolver: Resolver::new(),
        })
    }

    pub fn dispatch(&mut self, call: ToolCall) -> ToolResult {
        self.anchor_store.advance_turn();
        let result = match call {
            ToolCall::Observe(p) => tools::observe::handle(p, self),
            ToolCall::Match(p) => tools::match_tool::handle(p, self),
            ToolCall::Patch(p) => tools::patch::handle(p, self),
            ToolCall::Commit(p) => tools::commit::handle(p, self),
        };
        // Periodic GC
        if self.anchor_store.current_turn() % 50 == 0 {
            self.anchor_store.gc(100);
        }
        match result {
            Ok(r) => r,
            Err(e) => ToolResult { status: "error".into(), error: Some(e), ..Default::default() },
        }
    }
}
```

Each handler signature: `fn handle(params: XxxParams, state: &mut ScaState) -> Result<ToolResult, ToolError>`

This avoids the multiple-mutable-borrow problem. Inside each handler, access `state.file_manager`, `state.anchor_store`, etc. as needed. Since the handler has exclusive `&mut ScaState`, Rust allows access to disjoint fields.

**Known caveat:** The resolver's `resolve()` needs `&mut store` and `&mut file_manager` and `&self indexer` simultaneously. Inside the handler, extract what you need:
```rust
// This works because we're borrowing disjoint fields of state:
let resolved = state.resolver.resolve(
    anchor_id,
    &mut state.anchor_store,
    &mut state.file_manager,
    &state.indexer,
);
```
Rust's borrow checker allows this because `resolver`, `anchor_store`, `file_manager`, and `indexer` are separate fields.

### 10.1 OBSERVE (`src/tools/observe.rs`)

```rust
pub fn handle(params: ObserveParams, state: &mut ScaState) -> Result<ToolResult, ToolError> {
    // 1. Resolve target to (file, optional byte range filter)
    let targets: Vec<(String, Option<Range<usize>>)> = if params.target.starts_with("@") {
        // It's an anchor id
        let resolved = state.resolver.resolve(
            &params.target, &mut state.anchor_store, &mut state.file_manager, &state.indexer
        )?;
        vec![(resolved.anchor.file, Some(resolved.byte_range))]
    } else {
        // File path, directory, or glob
        let files = state.file_manager.resolve_target(&params.target)?;
        files.into_iter().map(|f| (f, None)).collect()
    };

    let mut output_parts = Vec::new();
    let mut all_anchors = Vec::new();

    for (file, range_filter) in &targets {
        let (content, version) = state.file_manager.read(file)?;
        let index = state.indexer.index(file, &content, version);

        // Filter by depth and range
        let nodes: Vec<&IndexedNode> = index.nodes.iter()
            .filter(|n| n.depth <= params.depth)
            .filter(|n| match range_filter {
                Some(r) => ranges_overlap(&n.byte_range, r),
                None => true,
            })
            .collect();

        // IMPORTANT: Store anchors FIRST to get IDs, THEN format.
        // Formatters need anchor IDs to insert inline [@a_XXXX] markers.
        // Deduplicate by (file, structural_path) to prevent Scope lens from
        // creating duplicate anchors for the same node.
        let mut nodes_with_ids: Vec<(&IndexedNode, AnchorId)> = Vec::new();
        let mut seen_paths: HashSet<(String, String)> = HashSet::new();
        for node in &nodes {
            let key = (file.clone(), node.structural_path.clone());
            if seen_paths.contains(&key) {
                // Already stored — find the existing ID
                let existing_id = nodes_with_ids.iter()
                    .find(|(n, _)| n.structural_path == node.structural_path)
                    .map(|(_, id)| id.clone())
                    .unwrap();
                nodes_with_ids.push((node, existing_id));
                continue;
            }
            seen_paths.insert(key);
            let anchor = node_to_anchor(node, file, version);
            let id = state.anchor_store.store(anchor);
            all_anchors.push(AnchorDisplay {
                id: id.clone(),
                display: formatter::anchor_display(node, file),
            });
            nodes_with_ids.push((node, id));
        }

        // Apply lens (formatters receive nodes paired with their assigned IDs)
        let formatted = match params.lens {
            Lens::Full => formatter::format_full(&content, &nodes_with_ids, file),
            Lens::Signatures => formatter::format_signatures(&nodes_with_ids, &content, file),
            Lens::Skeleton => formatter::format_skeleton(&nodes_with_ids, &content, file),
            Lens::Scope => formatter::format_scope(&nodes_with_ids, &content, file, &index),
        };

        output_parts.push(formatted);
    }

    Ok(ToolResult {
        status: "ok".into(),
        content: Some(output_parts.join("\n\n---\n\n")),
        anchors: all_anchors,
        ..Default::default()
    })
}

fn node_to_anchor(node: &IndexedNode, file: &str, version: FileVersion) -> Anchor {
    Anchor {
        id: String::new(),  // assigned by store on insertion
        file: file.to_string(),
        structural: StructuralInfo { path: node.structural_path.clone() },
        contextual: ContextualInfo { hash: node.simhash, version },
        positional: PositionalInfo {
            byte_start: node.byte_range.start,
            byte_end: node.byte_range.end,
            line_start: node.line_start,
            line_end: node.line_end,
            ordinal: node.ordinal,
            ordinal_context: node.ordinal_context.clone(),
        },
        kind: node.kind,
        // Parent anchor IDs are NOT populated here. They would require
        // a lookup from parent_index → stored anchor ID, which isn't available
        // at this point (parent may not be stored yet, or may have a different ID
        // from a previous OBSERVE). Set to None.
        // The structural path already encodes the parent relationship
        // (e.g., "mod:Class.method" implies Class is the parent).
        parent: None,
        created_at_version: version,
    }
}
```

### 10.2 MATCH (`src/tools/match_tool.rs`)

v0.1: Text mode only.

```rust
pub fn handle(params: MatchParams, state: &mut ScaState) -> Result<ToolResult, ToolError> {
    // Only Text mode in v0.1
    if params.mode != MatchMode::Text {
        return Err(ToolError {
            kind: "UNSUPPORTED".into(),
            message: "Only text search mode is supported in v0.1".into(),
            ..
        });
    }

    // Determine files to search
    let files = match &params.scope {
        Some(scope) if scope.starts_with("@") => {
            let resolved = state.resolver.resolve(scope, ...)?;
            vec![resolved.anchor.file]
        }
        Some(scope) => state.file_manager.resolve_target(scope)?,
        None => state.file_manager.resolve_target(".")?,
    };

    let query_lower = params.query.to_lowercase();
    let mut results: Vec<AnchorDisplay> = Vec::new();
    let mut seen_keys: HashSet<(String, String)> = HashSet::new();  // (file, structural_path)

    for file in &files {
        let (content, version) = state.file_manager.read(file)?;
        let content_lower = content.to_lowercase();

        // Index ONCE per file, outside the match loop
        let index = state.indexer.index(file, &content, version);

        // Find all substring matches
        let mut search_start = 0;
        while let Some(pos) = content_lower[search_start..].find(&query_lower) {
            let byte_pos = search_start + pos;

            // Find the deepest enclosing anchored node
            let enclosing = index.nodes.iter()
                .filter(|n| n.byte_range.start <= byte_pos && byte_pos < n.byte_range.end)
                .max_by_key(|n| n.depth);

            if let Some(node) = enclosing {
                let key = (file.clone(), node.structural_path.clone());
                if !seen_keys.contains(&key) {
                    seen_keys.insert(key);
                    let anchor = node_to_anchor(node, file, version);
                    let id = state.anchor_store.store(anchor);
                    results.push(AnchorDisplay {
                        id,
                        display: formatter::anchor_display(node, file),
                    });
                }
            }

            search_start = byte_pos + 1;
            if results.len() >= params.limit { break; }
        }
        if results.len() >= params.limit { break; }
    }

    Ok(ToolResult {
        status: "ok".into(),
        content: Some(format!("{} match(es) found", results.len())),
        anchors: results,
        ..Default::default()
    })
}
```

### 10.3 PATCH (`src/tools/patch.rs`)

```rust
pub fn handle(params: PatchParams, state: &mut ScaState) -> Result<ToolResult, ToolError> {
    let anchor_id = params.anchor_id().to_string();

    // 1. Resolve anchor
    let resolved = state.resolver.resolve(
        &anchor_id, &mut state.anchor_store, &mut state.file_manager, &state.indexer
    )?;

    // 2. Read current file and CAS check
    let (content, current_version) = state.file_manager.read(&resolved.anchor.file)?;
    check_cas(params.cas_version(), current_version, &anchor_id)?;

    let byte_range = resolved.byte_range.clone();
    let old_text = content[byte_range.clone()].to_string();
    let file = resolved.anchor.file.clone();

    // 3. Compute new file content and inverse
    let (new_file_content, inverse) = match &params {
        PatchParams::Replace { content: new_content, validate, .. } => {
            let indented = auto_indent(new_content, &old_text, &content, byte_range.start);
            let new_file = apply_replacement(&content, &byte_range, &indented);

            // Syntax validation: parse result and reject if new ERROR nodes appear
            if *validate {
                check_syntax_after_edit(&new_file, &file, &state.indexer)?;
            }

            let inverse = PatchParams::Replace {
                anchor: anchor_id.clone(),
                content: old_text.clone(),
                cas_version: None,
                validate: false,
            };
            (new_file, inverse)
        }

        PatchParams::InsertBefore { content: new_content, .. } => {
            let indented = auto_indent(new_content, &old_text, &content, byte_range.start);
            let separator = "\n\n";
            let new_file = format!(
                "{}{}{}{}",
                &content[..byte_range.start],
                &indented,
                separator,
                &content[byte_range.start..]
            );
            // Inverse for inserts is not computable at this point: we don't have
            // an anchor ID for the newly inserted content yet (it hasn't been indexed).
            // To undo, use COMMIT::Undo which restores old_content from the edit log.
            let inverse = None;
            (new_file, inverse)
        }

        PatchParams::InsertAfter { content: new_content, .. } => {
            let indented = auto_indent(new_content, &old_text, &content, byte_range.start);
            let separator = "\n\n";
            let new_file = format!(
                "{}{}{}{}",
                &content[..byte_range.end],
                separator,
                &indented,
                &content[byte_range.end..]
            );
            // Same as InsertBefore: no inverse. Use COMMIT::Undo.
            let inverse = None;
            (new_file, inverse)
        }

        PatchParams::Delete { .. } => {
            // Delete the node's content. Also clean up surrounding blank lines.
            let new_file = delete_range(&content, &byte_range);
            let inverse = Some(PatchParams::InsertBefore {
                anchor: anchor_id.clone(),
                content: old_text.clone(),
                cas_version: None,
            });
            (new_file, inverse)
        }

        PatchParams::Rename { rename_to, .. } => {
            // File-scoped rename only (project-wide deferred to v0.2)
            return handle_rename_file_scope(
                &resolved, rename_to, state
            );
        }
    };

    // 4. Write the file
    let new_version = state.file_manager.write(&file, &new_file_content)?;

    // 5. Invalidate old anchors, refresh
    state.anchor_store.invalidate_file(&file);

    // Re-index to get fresh anchors for the edited region
    let new_index = state.indexer.index(&file, &new_file_content, new_version);

    // Try to find the edited node in the new index by structural path
    let refreshed_display = if let Some(nodes) = new_index.structural_map.get(&resolved.anchor.structural.path) {
        if let Some(&idx) = nodes.first() {
            let node = &new_index.nodes[idx];
            let anchor = node_to_anchor(node, &file, new_version);
            let id = state.anchor_store.store(anchor);
            vec![AnchorDisplay {
                id,
                display: formatter::anchor_display(node, &file),
            }]
        } else { vec![] }
    } else { vec![] };

    Ok(ToolResult {
        status: "applied".into(),
        anchors: refreshed_display,
        inverse,  // Some for Replace/Delete, None for Insert operations
        ..Default::default()
    })
}
```

**Helper functions** (used by PATCH and OBSERVE):

```rust
/// Delete a byte range from content, cleaning up surrounding blank lines.
fn delete_range(content: &str, range: &Range<usize>) -> String {
    let before = &content[..range.start];
    let after = &content[range.end..];

    // If deletion leaves a double-blank-line, collapse to single
    let before_trimmed = before.trim_end_matches('\n');
    let after_trimmed = after.trim_start_matches('\n');

    if before_trimmed.is_empty() {
        after_trimmed.to_string()
    } else if after_trimmed.is_empty() {
        format!("{}\n", before_trimmed)
    } else {
        format!("{}\n\n{}", before_trimmed, after_trimmed)
    }
}

/// Apply a byte-range replacement in a string.
fn apply_replacement(content: &str, range: &Range<usize>, new_text: &str) -> String {
    let mut result = String::with_capacity(content.len() - range.len() + new_text.len());
    result.push_str(&content[..range.start]);
    result.push_str(new_text);
    result.push_str(&content[range.end..]);
    result
}

/// Check if two byte ranges overlap.
fn ranges_overlap(a: &Range<usize>, b: &Range<usize>) -> bool {
    a.start < b.end && b.start < a.end
}

/// Find the first ERROR node in a tree-sitter parse tree (DFS).
fn find_first_error(node: tree_sitter::Node) -> Option<tree_sitter::Node> {
    if node.is_error() || node.is_missing() {
        return Some(node);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(err) = find_first_error(child) {
            return Some(err);
        }
    }
    None
}
```

**Auto-indent (simple approach):**

```rust
/// Simple auto-indent: detect the indentation of old_text's first line,
/// apply the same indentation to new_text.
/// Does NOT handle mixed tabs/spaces. Does NOT infer indent style.
/// Just matches what was there before.
fn auto_indent(new_text: &str, old_text: &str, file_content: &str, insert_pos: usize) -> String {
    // Detect indent of the line at insert_pos
    let line_start = file_content[..insert_pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
    let line = &file_content[line_start..];
    let target_indent: &str = &line[..line.len() - line.trim_start().len()];

    // Detect indent of new_text's first line
    let first_line = new_text.lines().next().unwrap_or("");
    let source_indent: &str = &first_line[..first_line.len() - first_line.trim_start().len()];

    // Re-indent: strip source, add target
    new_text.lines()
        .map(|line| {
            if line.starts_with(source_indent) {
                format!("{}{}", target_indent, &line[source_indent.len()..])
            } else {
                format!("{}{}", target_indent, line.trim_start())
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
```

**Syntax check (inlined, replaces VALIDATE tool):**

```rust
fn check_syntax_after_edit(new_content: &str, file: &str, indexer: &Indexer) -> Result<(), ToolError> {
    let config = indexer.registry().config_for_file(file);
    match config {
        LanguageConfig::TreeSitter(ts_config) => {
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(ts_config.language())
                .expect("Failed to set tree-sitter language");
            if let Some(tree) = parser.parse(new_content, None) {
                if tree.root_node().has_error() {
                    // Find the ERROR node for a useful message
                    let error_node = find_first_error(tree.root_node());
                    let line = error_node.map(|n| n.start_position().row + 1).unwrap_or(0);
                    return Err(ToolError {
                        kind: "SYNTAX_ERROR".into(),
                        message: format!("Edit would produce syntax error at line {}", line),
                        anchor: None,
                        candidates: vec![],
                        suggestion: "Check the content for syntax issues. The edit was NOT applied.".into(),
                    });
                }
            }
        }
        LanguageConfig::Fallback(_) => {} // no syntax checking for plain text
    }
    Ok(())
}
```

**handle_rename_file_scope:**

```rust
/// Rename an identifier within a single file.
///
/// KNOWN LIMITATION (v0.1): This renames ALL occurrences of the identifier
/// in the file that appear as identifier nodes in the AST (not in strings or
/// comments). It does NOT perform scope analysis — if two different functions
/// both have a local variable named `x` and you rename one, both get renamed.
/// For v0.2, scope-aware rename should be added using tree-sitter's scoping
/// queries or a simple scope-walk.
fn handle_rename_file_scope(
    resolved: &ResolvedAnchor,
    new_name: &str,
    state: &mut ScaState,
) -> Result<ToolResult, ToolError> {
    let old_name = resolved.anchor.structural.path
        .rsplit('.').next()  // last segment = current name
        .ok_or(ToolError::new("INVALID_ANCHOR", "Anchor has no name segment", "Use a named anchor"))?;
    let file = &resolved.anchor.file;
    let (content, version) = state.file_manager.read(file)?;

    // CAS check: verify the file hasn't changed since the anchor was created
    if version != resolved.anchor.contextual.version {
        return Err(ToolError::new(
            "CAS_CONFLICT",
            format!("File {} changed since anchor was created (anchor version {}, current {})",
                file, resolved.anchor.contextual.version, version),
            "Re-OBSERVE the file to get fresh anchors",
        ));
    }

    // Find all identifier occurrences of old_name in this file
    // Use the indexer to verify each is an identifier node (not in string/comment)
    let config = state.indexer.registry().config_for_file(file);
    let occurrences = find_identifier_occurrences(&content, old_name, &config);

    // Apply replacements in reverse byte order (so earlier ones don't shift later ones)
    let mut new_content = content.clone();
    for range in occurrences.into_iter().rev() {
        new_content.replace_range(range, new_name);
    }

    let new_version = state.file_manager.write(file, &new_content)?;
    state.anchor_store.invalidate_file(file);

    Ok(ToolResult {
        status: "applied".into(),
        content: Some(format!("Renamed '{}' to '{}' in {}", old_name, new_name, file)),
        ..Default::default()
    })
}

/// Find byte ranges of all occurrences of `name` that are identifier nodes.
/// Recursively walk tree-sitter nodes, collecting byte ranges of identifier nodes
/// whose text matches `name`, skipping comments and string literals.
fn walk_for_identifiers(
    cursor: &mut tree_sitter::TreeCursor,
    source: &[u8],
    name: &str,
    results: &mut Vec<Range<usize>>,
    ident_kinds: &[&str],
    comment_kinds: &[&str],
    string_kinds: &[&str],
) {
    loop {
        let node = cursor.node();
        let kind = node.kind();

        // Skip comment subtrees entirely
        if comment_kinds.contains(&kind) {
            if !cursor.goto_next_sibling() { return; }
            continue;
        }

        // Skip string literal subtrees — use explicit type list, not heuristic
        if string_kinds.contains(&kind) {
            if !cursor.goto_next_sibling() { return; }
            continue;
        }

        // Check if this is an identifier node matching our name
        if ident_kinds.contains(&kind) && node.byte_range().len() == name.len() {
            if let Ok(text) = std::str::from_utf8(&source[node.start_byte()..node.end_byte()]) {
                if text == name {
                    results.push(node.start_byte()..node.end_byte());
                }
            }
        }

        // Recurse into children
        if cursor.goto_first_child() {
            walk_for_identifiers(cursor, source, name, results, ident_kinds, comment_kinds, string_kinds);
            cursor.goto_parent();
        }

        if !cursor.goto_next_sibling() {
            return;
        }
    }
}

/// Uses tree-sitter to verify context (not inside string literal or comment).
fn find_identifier_occurrences(content: &str, name: &str, config: &LanguageConfig) -> Vec<Range<usize>> {
    match config {
        LanguageConfig::TreeSitter(ts) => {
            let mut parser = tree_sitter::Parser::new();
            parser.set_language(ts.language())
                .expect("Failed to set tree-sitter language");
            let tree = parser.parse(content, None).unwrap();
            let mut results = Vec::new();

            // Walk all nodes, find identifier nodes whose text matches
            let mut cursor = tree.walk();
            let ident_kinds = ts.identifier_node_types();  // ["identifier"] for Python, etc.
            let comment_kinds = ts.comment_node_types();
            let string_kinds = ts.string_node_types();
            walk_for_identifiers(&mut cursor, content.as_bytes(), name, &mut results, ident_kinds, comment_kinds, string_kinds);
            results
        }
        LanguageConfig::Fallback(_) => {
            // Simple text replacement for non-tree-sitter files.
            // Check word boundaries: alphanumeric OR underscore counts as word char.
            let mut results = Vec::new();
            let mut start = 0;
            while let Some(pos) = content[start..].find(name) {
                let abs_pos = start + pos;
                let before_ok = abs_pos == 0 || {
                    let b = content.as_bytes()[abs_pos - 1];
                    !b.is_ascii_alphanumeric() && b != b'_'
                };
                let after_pos = abs_pos + name.len();
                let after_ok = after_pos >= content.len() || {
                    let b = content.as_bytes()[after_pos];
                    !b.is_ascii_alphanumeric() && b != b'_'
                };
                if before_ok && after_ok {
                    results.push(abs_pos..abs_pos + name.len());
                }
                start = abs_pos + 1;
            }
            results
        }
    }
}
```

### 10.4 COMMIT (`src/tools/commit.rs`)

```rust
pub fn handle(params: CommitParams, state: &mut ScaState) -> Result<ToolResult, ToolError> {
    match params.action {
        CommitAction::Snapshot => {
            let label = params.label.unwrap_or_else(|| {
                format!("snap_{}", state.anchor_store.current_turn())
            });
            state.file_manager.snapshot(&label)?;
            Ok(ToolResult {
                status: "ok".into(),
                content: Some(format!("Snapshot '{}' created", label)),
                ..Default::default()
            })
        }

        CommitAction::Restore => {
            let label = params.r#ref.ok_or(
                ToolError::new("MISSING_PARAM", "restore requires a 'ref' parameter", "Provide ref: \"snapshot_label\"")
            )?;
            let changed = state.file_manager.restore(&label)?;
            for file in &changed {
                state.anchor_store.remove_file(file);
            }
            Ok(ToolResult {
                status: "ok".into(),
                content: Some(format!("Restored to '{}'. {} file(s) changed.", label, changed.len())),
                ..Default::default()
            })
        }

        CommitAction::Undo => {
            let changed = state.file_manager.undo(params.count)?;
            for file in &changed {
                state.anchor_store.invalidate_file(file);
            }
            Ok(ToolResult {
                status: "ok".into(),
                content: Some(format!("Undid {} edit(s).", params.count)),
                ..Default::default()
            })
        }

        CommitAction::Log => {
            let log = state.file_manager.log();
            let entries: Vec<String> = log.iter().enumerate().map(|(i, entry)| {
                let age = entry.timestamp.elapsed().map(|d| format!("{}s ago", d.as_secs())).unwrap_or_else(|_| "unknown".into());
                format!("{}. {} ({})", i + 1, entry.file, age)
            }).collect();
            Ok(ToolResult {
                status: "ok".into(),
                content: Some(if entries.is_empty() {
                    "No edits yet.".into()
                } else {
                    entries.join("\n")
                }),
                ..Default::default()
            })
        }
    }
}
```

### Tool handler tests

```
test_observe_full:
    OBSERVE("fixtures/python/session.py", lens=Full)
    → status "ok", content contains "class SessionManager", anchors non-empty

test_observe_signatures:
    OBSERVE("fixtures/python/session.py", lens=Signatures)
    → content contains "def validate_token" with "..."
    → content does NOT contain "return False" (body hidden)

test_observe_anchor_target:
    OBSERVE(file) → get anchor for validate_token
    OBSERVE(anchor_id, lens=Scope) → content contains full method body

test_match_text:
    MATCH(query="validate_token", mode=Text, scope="fixtures/python/")
    → returns anchors, at least one for session.py

test_patch_replace:
    OBSERVE → anchor_id
    PATCH::Replace { anchor: id, content: "new body" }
    → status "applied", inverse present
    read file → new body present

test_patch_replace_auto_indent:
    OBSERVE → anchor for a method (indented 4 spaces)
    PATCH::Replace with content starting at column 0
    → file content has method indented at 4 spaces

test_patch_replace_syntax_error:
    PATCH::Replace { content: "def foo(\n    broken" }
    → SYNTAX_ERROR, file unchanged

test_patch_insert_after:
    PATCH::InsertAfter { anchor, content: "def new_func(): pass" }
    → new function appears after target

test_patch_delete:
    PATCH::Delete { anchor }
    → node removed from file

test_patch_rename:
    PATCH::Rename { anchor for validate_token, rename_to: "verify_token" }
    → file contains "verify_token" everywhere that had "validate_token"
    → "validate_token" no longer appears as an identifier

test_commit_snapshot_restore:
    PATCH(edit file), COMMIT::Snapshot, PATCH(edit again), COMMIT::Restore
    → file back to post-first-patch state

test_commit_undo:
    PATCH three times, COMMIT::Undo { count: 2 }
    → file at post-first-patch state

test_commit_log:
    PATCH twice, COMMIT::Log
    → 2 entries in output
```


---

## 11. Module 8: Router & Formatter

**File:** `src/router.rs`, `src/formatter.rs`, `src/main.rs`  
**Dependencies:** all previous modules

### Router

```rust
// src/router.rs

use std::io::{BufRead, Read, Write};

const MAX_INPUT_LINE: usize = 10 * 1024 * 1024;  // 10 MB max per input line
const MAX_DRAIN_BYTES: usize = 1024 * 1024;       // 1 MB max drain when skipping oversize line

pub fn run(state: &mut ScaState) -> Result<(), Box<dyn std::error::Error>> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = stdin.lock();

    // Bounded line reader. Guarantees:
    // 1. Never allocates more than MAX_INPUT_LINE + 1 bytes.
    // 2. On oversize input, drains at most MAX_DRAIN_BYTES looking for newline,
    //    then gives up (returns error and moves on, or exits on apparent binary stream).
    let mut buf = Vec::with_capacity(4096);

    loop {
        buf.clear();
        let mut oversize = false;
        let mut total_drained: usize = 0;

        loop {
            let available = reader.fill_buf()?;
            if available.is_empty() { break; }  // EOF

            // Find newline in buffer
            if let Some(pos) = available.iter().position(|&b| b == b'\n') {
                let to_consume = pos + 1;  // include the newline
                if !oversize {
                    if buf.len() + to_consume > MAX_INPUT_LINE + 1 {
                        oversize = true;
                    } else {
                        buf.extend_from_slice(&available[..to_consume]);
                    }
                }
                reader.consume(to_consume);
                break;
            }

            // No newline found — consume the entire available buffer
            let len = available.len();
            if !oversize {
                if buf.len() + len > MAX_INPUT_LINE + 1 {
                    // Take what fits, then mark oversize
                    let remaining = (MAX_INPUT_LINE + 1).saturating_sub(buf.len());
                    buf.extend_from_slice(&available[..remaining]);
                    oversize = true;
                    total_drained = len - remaining;
                } else {
                    buf.extend_from_slice(available);
                }
            } else {
                total_drained += len;
            }
            reader.consume(len);

            // If draining and we've exceeded the drain cap, stop waiting for newline.
            // This prevents hanging on infinite binary input with no newlines.
            if oversize && total_drained > MAX_DRAIN_BYTES {
                break;
            }
        }

        if buf.is_empty() && !oversize { break; }  // EOF with no data

        if oversize {
            let result = ToolResult {
                status: "error".into(),
                error: Some(ToolError::new(
                    "INPUT_TOO_LARGE",
                    format!("Input line exceeds {} bytes", MAX_INPUT_LINE),
                    "Send smaller requests",
                )),
                ..Default::default()
            };
            let json = serde_json::to_string(&result)?;
            {
                let mut out = stdout.lock();
                writeln!(out, "{}", json)?;
                out.flush()?;
            }
            continue;
        }

        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s.trim(),
            Err(_) => {
                // Non-UTF8 input — skip
                continue;
            }
        };
        if line.is_empty() { continue; }

        let result = match serde_json::from_str::<ToolCall>(line) {
            Ok(call) => state.dispatch(call),
            Err(e) => ToolResult {
                status: "error".into(),
                error: Some(ToolError {
                    kind: "PARSE_ERROR".into(),
                    message: format!("Invalid JSON: {}", e),
                    anchor: None,
                    candidates: vec![],
                    suggestion: "Check JSON formatting.".into(),
                }),
                ..Default::default()
            },
        };

        let json = serde_json::to_string(&result)?;
        {
            let mut out = stdout.lock();
            writeln!(out, "{}", json)?;
            out.flush()?;
        }
    }
    Ok(())
}
```

### Main

```rust
// src/main.rs

fn main() {
    let root = std::env::current_dir().expect("Cannot determine working directory");
    let mut state = sca::ScaState::new(root).expect("Failed to initialize SCA");
    sca::router::run(&mut state).expect("Router error");
}
```

No flags, no arguments. Working directory is the project root. stdin/stdout JSON-RPC.

### Formatter

```rust
// src/formatter.rs

/// Inline anchor marker: "[@a_7f3c]"
pub fn inline_anchor(id: &AnchorId) -> String {
    format!("[{}]", id)
}

/// Display string for anchors list: "auth.session:SessionManager.validate_token (method, L42-58)"
pub fn anchor_display(node: &IndexedNode, file: &str) -> String {
    let kind_label = match node.kind {
        NodeKind::Code(CodeNodeKind::Module) => "module",
        NodeKind::Code(CodeNodeKind::Class) => "class",
        NodeKind::Code(CodeNodeKind::Function) => "function",
        NodeKind::Code(CodeNodeKind::Method) => "method",
        NodeKind::Code(CodeNodeKind::Block) => "block",
        NodeKind::Code(CodeNodeKind::Statement) => "statement",
        NodeKind::Text(TextNodeKind::Document) => "document",
        NodeKind::Text(TextNodeKind::Paragraph) => "paragraph",
    };
    format!("{} ({}, L{}-{})", node.structural_path, kind_label, node.line_start, node.line_end)
}

/// Format full content with inline anchors.
/// Inserts [@anchor_id] markers on the line before each anchored node.
/// All anchor IDs are assigned before this function is called.
pub fn format_full(content: &str, nodes_with_ids: &[(&IndexedNode, &AnchorId)], file: &str) -> String {
    // Strategy: for each node, annotate its first line with an inline anchor prefix.
    // Sort by byte_range.start (they should already be in order).
    // Walk through content line by line, inserting markers.

    let mut annotations: HashMap<usize, Vec<String>> = HashMap::new(); // line_start → [markers]
    for (node, anchor_id) in nodes_with_ids {
        annotations.entry(node.line_start)
            .or_default()
            .push(inline_anchor(anchor_id));
    }
    // Walk content lines, prepend markers where present
    todo!("implement line-by-line annotation")
}

/// Format signatures-only view.
pub fn format_signatures(nodes_with_ids: &[(&IndexedNode, &AnchorId)], content: &str, file: &str) -> String {
    // For each node at depth 0 or 1:
    //   Print indent (based on depth) + [@anchor_id] + first line of node + " ..."  + "# L{start}-{end}"
    // Example:
    //   [@a_2b1a] class SessionManager:                    # L10-120
    //     [@a_3c4d]   def __init__(self, store, ttl): ...  # L12-18
    todo!()
}

/// Format skeleton: signature + first meaningful line + ... + last line
pub fn format_skeleton(nodes_with_ids: &[(&IndexedNode, &AnchorId)], content: &str, file: &str) -> String {
    todo!()
}

/// Format scope: full content of target + signatures of siblings
pub fn format_scope(nodes_with_ids: &[(&IndexedNode, &AnchorId)], content: &str, file: &str, index: &FileIndex) -> String {
    // Assumption: first element of nodes_with_ids is the target (show full content).
    // Remaining elements are siblings (show signature only).
    todo!()
}
```

**Note for implementor:** The formatter functions above have `todo!()` bodies. This is the one module where you have creative freedom — the exact formatting is flexible as long as:
1. Anchor IDs appear inline as `[@a_XXXX]` before the code they reference
2. Signatures lens shows only the first line of each node + `...`
3. Skeleton shows first + last line with `...` between
4. Scope shows full target + sibling signatures
5. Output is readable by an LLM (not excessively noisy)

### Tests

```
test_inline_anchor:
    assert inline_anchor("@a_7f3c") == "[@a_7f3c]"

test_anchor_display:
    node with path "test:Foo.bar", kind Method, lines 10-20
    assert display contains "test:Foo.bar" and "method" and "L10-20"

test_signatures_hides_bodies:
    formatted = format_signatures for session.py
    assert formatted.contains("def validate_token")
    assert formatted.contains("...")
    assert !formatted.contains("return False")

test_round_trip_json:
    spawn binary, send OBSERVE json, read response
    assert valid JSON
    assert status == "ok"

test_malformed_json:
    send "not json" to binary
    response is error with kind "PARSE_ERROR", binary does not crash

test_input_too_large:
    send a line of 11MB of 'x' characters to binary
    response is error with kind "INPUT_TOO_LARGE", binary does not crash
    send a valid OBSERVE after — binary still responds correctly (not wedged)

test_unknown_tool:
    send {"tool": "explode", "params": {}}
    response is error (serde will fail to deserialize)
```


---

## 12. Integration Tests

End-to-end tests via JSON-RPC. These are the **shipping gate for v0.1**. ALL must pass.

Each test spawns the SCA binary as a subprocess, writes JSON lines to stdin, reads JSON lines from stdout.

### Test 1: Observe → Patch → Observe cycle

```
1. OBSERVE("tests/fixtures/python/session.py", lens="signatures")
   assert: status "ok"
   assert: anchors list contains entry with "validate_token" in display
   assert: content contains "def validate_token" and "..."

2. Extract anchor_id for validate_token → VT_ID

3. OBSERVE(target=VT_ID, lens="scope")
   assert: content contains "return False"

4. PATCH::Replace { anchor: VT_ID, content: "def validate_token(self, token: str) -> bool:\n    if not token:\n        raise ValueError('empty')\n    return self._is_expired(token)" }
   assert: status "applied"
   assert: inverse is present

5. OBSERVE(target=VT_ID, lens="scope")
   assert: content contains "raise ValueError"
   assert: content does NOT contain "return False"

6. COMMIT::Undo { count: 1 }

7. OBSERVE(target=VT_ID, lens="scope")
   assert: content contains "return False" (restored)
```

### Test 2: Stale anchor resolution

```
1. OBSERVE("tests/fixtures/python/session.py", lens="full")
   → get VT_ID for validate_token, INIT_ID for __init__

2. PATCH::Replace { anchor: INIT_ID, content: "def __init__(self, store, ttl: int = 7200):\n    self.store = store\n    self.ttl = ttl\n    self._cache = {}\n    self._initialized = True" }
   → VT_ID is now stale (file version changed)

3. PATCH::Replace { anchor: VT_ID, content: "def validate_token(self, token: str) -> bool:\n    return True" }
   assert: status "applied" (resolver handles stale anchor)
```

### Test 3: CAS conflict

```
1. OBSERVE("tests/fixtures/python/session.py") → VT_ID at version V

2. Write directly to the fixture file (bypassing SCA) — simulate external edit

3. PATCH::Replace { anchor: VT_ID, content: "...", cas_version: V }
   assert: status "error"
   assert: error.kind == "CAS_CONFLICT"
```

### Test 4: Snapshot and restore

```
1. COMMIT::Snapshot { label: "clean" }
2. PATCH (edit session.py)
3. PATCH (edit session.py again)
4. COMMIT::Restore { ref: "clean" }
5. OBSERVE → content matches original fixture
```

### Test 5: Delete operation

```
1. OBSERVE → anchor for _is_expired method
2. PATCH::Delete { anchor: IS_EXPIRED_ID }
3. OBSERVE (full lens) → _is_expired no longer in file
4. COMMIT::Undo { count: 1 }
5. OBSERVE → _is_expired is back
```

### Test 6: Insert operations

```
1. OBSERVE → anchor for validate_token
2. PATCH::InsertAfter { anchor: VT_ID, content: "def new_method(self):\n    pass" }
3. OBSERVE (signatures lens) → new_method appears after validate_token
```

### Test 7: File-scoped rename

```
1. OBSERVE("tests/fixtures/python/session.py") → VT_ID
2. PATCH::Rename { anchor: VT_ID, rename_to: "verify_token" }
3. Read session.py → "verify_token" in definition
4. Read session.py → "validate_token" does NOT appear as identifier
```

### Test 8: Fallback (plain text)

```
1. OBSERVE("tests/fixtures/notes.txt", lens="full")
   assert: anchors present, structural paths are "_para[0]", "_para[1]", etc.

2. Get anchor for second paragraph → PARA_ID

3. PATCH::Replace { anchor: PARA_ID, content: "Replaced paragraph content.\nWith two lines." }
   assert: applied

4. OBSERVE("tests/fixtures/notes.txt", lens="full")
   assert: second paragraph is replaced
   assert: other paragraphs unchanged
```

### Test 9: MATCH text search

```
1. MATCH(query="validate_token", mode="text", scope="tests/fixtures/python/")
   assert: status "ok"
   assert: at least 2 anchors (one in session.py, one in middleware.py)
   assert: anchors have valid ids starting with "@a_"
```

### Test 10: Unicode content

```
1. Write a temp Python file: "def café():\n    return '日本語'\n\ndef naïve():\n    pass"
2. OBSERVE(temp_file, lens="signatures")
   assert: anchors include "café" and "naïve"
   assert: no panics, no garbled output

3. PATCH::Replace { anchor for café, content: "def café():\n    return '中文'" }
   assert: applied
   assert: file content correct (no byte-offset corruption)
```

### Test 11: Empty and comment-only files

```
1. OBSERVE on empty Python file ("")
   assert: status "ok", anchors may be empty, no panic

2. OBSERVE on comment-only file ("# just a comment\n# nothing else\n")
   assert: status "ok", no panic
```

### Test 12: GC'd anchor produces clear error

```
1. OBSERVE → get anchor VT_ID
2. Advance 200 turns (by sending 200 OBSERVE calls to different files, or mock)
3. PATCH::Replace { anchor: VT_ID, content: "..." }
   assert: error with kind "RESOLUTION_FAILED"
   assert: message mentions "garbage collected" or similar
   assert: suggestion says to re-OBSERVE
```


---

## 13. Test Fixtures

Create these files exactly as shown. Integration tests use them.

**Important:** Tests should copy fixtures to a temp directory before mutating them, so the original fixtures are never modified.

### `tests/fixtures/python/session.py`

```python
"""Session management for authentication."""

from typing import Optional


class SessionManager:
    """Manages user sessions and token validation."""

    def __init__(self, store, ttl: int = 3600):
        self.store = store
        self.ttl = ttl
        self._cache = {}

    def create_token(self, user_id: str) -> str:
        """Create a new session token."""
        import uuid
        token = str(uuid.uuid4())
        self.store.set(token, {"user_id": user_id}, self.ttl)
        return token

    def validate_token(self, token: str) -> bool:
        """Validate a session token."""
        if not token:
            return False
        if self._is_expired(token):
            return False
        return self._verify_signature(token)

    def revoke_token(self, token: str) -> None:
        """Revoke a session token."""
        self.store.delete(token)
        if token in self._cache:
            del self._cache[token]

    def _is_expired(self, token: str) -> bool:
        data = self.store.get(token)
        if data is None:
            return True
        return False

    def _verify_signature(self, token: str) -> bool:
        return len(token) == 36


class TokenStore:
    """Simple key-value store for tokens."""

    def __init__(self, backend: str = "memory"):
        self.backend = backend
        self._data = {}

    def get(self, key: str) -> Optional[dict]:
        return self._data.get(key)

    def set(self, key: str, value: dict, ttl: int) -> None:
        self._data[key] = value

    def delete(self, key: str) -> bool:
        if key in self._data:
            del self._data[key]
            return True
        return False
```

### `tests/fixtures/python/middleware.py`

```python
"""Authentication middleware."""

from session import SessionManager


def require_auth(handler):
    """Decorator that requires a valid session token."""
    def wrapper(request):
        token = request.headers.get("Authorization", "").replace("Bearer ", "")
        manager = SessionManager(request.app.store)
        if not manager.validate_token(token):
            return {"status": 401, "error": "Unauthorized"}
        return handler(request)
    return wrapper


class AuthMiddleware:
    def __init__(self, app):
        self.app = app
        self.manager = SessionManager(app.store)

    def process_request(self, request):
        token = request.headers.get("Authorization", "")
        if token.startswith("Bearer "):
            token = token[7:]
        if not self.manager.validate_token(token):
            raise PermissionError("Invalid token")
        request.user = self.manager.get_user(token)
```

### `tests/fixtures/notes.txt`

```
These are some plain text notes.
They have no markdown formatting.
Just paragraphs separated by blank lines.

This is the second paragraph.
It has multiple lines too.

Third paragraph here.
Short one.

Final paragraph with some code-like content:
x = 1 + 2
y = foo(x)
```


---

## 14. Out of Scope for v0.1

Do NOT implement these. Listed here for awareness.

| Feature | Why deferred | Target |
|---|---|---|
| **VALIDATE tool** | Syntax check inlined into PATCH with `validate` flag. Full linting/type-checking/test-running adds external deps and output parsing complexity. | v0.2 |
| **Lens::Diff** | Requires git integration or snapshot diffing with structural mapping. Significant complexity for a lens that's useful but not critical. | v0.2 |
| **MATCH::Structural** | Tree-sitter query translation layer. Useful but Text mode covers 80% of cases. | v0.2 |
| **MATCH::Reference** | Symbol reference finding. Needs identifier scope analysis. | v0.2 |
| **MATCH::Semantic** | Embedding-based search. Needs embedding model, vector store. | v0.3 |
| **PatchOp::Wrap** | Template-based wrapping (`{body}` placeholder). Nice-to-have but non-trivial to get indent right. Model can use Replace instead. | v0.2 |
| **Project-wide rename** | Multi-file atomic rename with rollback. File-scoped rename is the v0.1 target. | v0.2 |
| **Markdown language config** | Heading-scoped sections. Section boundary detection is non-trivial. Python + Fallback proves the architecture. | v0.2 |
| **TypeScript/Rust/YAML configs** | Additional tree-sitter grammars. Add after Python is solid. | v0.2 |
| **File watching** (inotify/FSEvents) | External change detection on read() is sufficient. | v0.2 |
| **Git-backed snapshots** | In-memory snapshots work. Git integration is an optimization. | v0.2 |
| **MCP server mode** | JSON-RPC stdio is sufficient. MCP adds protocol negotiation. | v0.2 |
| **CommitAction::Diff** | Structural diff between current state and snapshot. Snapshot/restore/undo are the critical ops. | v0.2 |
| **Custom check in VALIDATE** | Shell command execution from model input = command injection. Must design sandbox first. | v0.3+ |
| **Multi-agent concurrency** | Locks, transactions, conflict resolution between concurrent agents. Single-agent CAS is sufficient. | v0.3 |
| **Persistent anchors** | Cross-session anchor serialization. Needs storage format and GC strategy. | v0.3+ |

---

## v0.1 Definition of Done

All of the following must be true:

1. `cargo build --release` succeeds with no warnings
2. `cargo test` passes all unit tests (Modules 1–8)
3. All 12 integration tests (Section 12) pass
4. Binary reads JSON from stdin, writes JSON to stdout, does not crash on malformed input
5. Path traversal attempts (`../`, symlinks outside root) are rejected with clear error
6. No shell command execution anywhere in the codebase (no `Command::new("sh")`, no string interpolation into commands)
7. Resource limits enforced: ≤10 snapshots, ≤500 edit log entries, ≤10k anchors, ≤200 cached files
8. Python files can be observed with all 4 lenses (full, signatures, skeleton, scope)
9. Python functions/methods can be patched (replace, insert_before, insert_after, delete, rename)
10. Plain text files work with fallback paragraph anchoring
11. Stale anchors resolve correctly when the file has been edited
12. CAS conflict is detected and reported with actionable error
13. Snapshot/restore/undo work correctly, including deletion of post-snapshot files
14. Auto-indentation matches surrounding context for Python 4-space indent
15. Syntax validation catches tree-sitter ERROR nodes and prevents bad edits (when `validate=true`)
16. Unicode content (non-ASCII identifiers, CJK strings) does not cause panics or byte-offset corruption
17. GC'd/deleted anchors produce clear error messages with recovery suggestions

---

## Summary for the implementing agent

You are building `sca`, a Rust binary. 5 JSON-RPC tools over stdio for code editing.

**Core idea:** LLMs get opaque anchor IDs from observation, pass them to mutation tools. No source text reproduction. Three-layer resolution (structural AST path, SimHash fingerprint, line position) survives staleness.

**v0.1 scope:** 4 tools (OBSERVE, MATCH, PATCH, COMMIT). Python + plain text fallback. 4 lenses. 5 patch operations. Text-only MATCH. File-scoped rename only. In-memory snapshots. No VALIDATE tool (syntax check is inlined into PATCH).

**Security:** All paths canonicalized and verified under project root. No shell execution. No model-controlled command execution.

**Build order:** types → simhash → lang configs → file manager → indexer → anchor store → resolver → tools → router → main. Test each phase before starting the next.

**Design reference:** `sca-proposal-full.md` for full rationale, worked examples, and future roadmap.

