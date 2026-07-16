#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { getExtensionPath } = require("@sqliteai/sqlite-vector");

const VECTOR_DIMENSION = 1024;
const ISSUE_ID_PATTERN = /^T-\d{3}$/;
const VALID_STATUSES = new Set(["backlog", "current", "done"]);
const VALID_EMBEDDING_STATUSES = new Set(["missing", "ready", "failed"]);

function emitProgress(message) {
  process.stderr.write(`issue-store: ${message}\n`);
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL UNIQUE CHECK (issue_id GLOB 'T-[0-9][0-9][0-9]'),
  triage_label TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'current', 'done')),
  body TEXT NOT NULL DEFAULT '',
  embedding BLOB,
  embedding_status TEXT NOT NULL DEFAULT 'missing'
    CHECK (embedding_status IN ('missing', 'ready', 'failed')),
  embedding_error TEXT,
  parent_issue_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_blockers (
  issue_id TEXT NOT NULL,
  blocker_issue_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, blocker_issue_id)
);

CREATE INDEX IF NOT EXISTS issues_status_index ON issues(status);
CREATE INDEX IF NOT EXISTS issues_label_index ON issues(triage_label);
CREATE INDEX IF NOT EXISTS issues_parent_index ON issues(parent_issue_id);
CREATE INDEX IF NOT EXISTS issues_embedding_status_index ON issues(embedding_status);

CREATE TABLE IF NOT EXISTS architecture_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL,
  section_index INTEGER NOT NULL,
  heading TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('context', 'doc', 'adr')),
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB,
  embedding_status TEXT NOT NULL DEFAULT 'missing'
    CHECK (embedding_status IN ('missing', 'ready', 'failed')),
  embedding_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_path, section_index)
);

CREATE INDEX IF NOT EXISTS architecture_documents_source_index
  ON architecture_documents(source_path);
CREATE INDEX IF NOT EXISTS architecture_documents_embedding_status_index
  ON architecture_documents(embedding_status);
`;

function now() {
  return new Date().toISOString();
}

function resolveDbPath(root, configuredPath) {
  const value = configuredPath || process.env.ISSUE_STORE_DB_PATH || path.join("docs", "issues.sqlite");
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function ensureArchitectureDocumentSchema(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'architecture_documents'")
    .get();
  if (!table?.sql || table.sql.includes("'doc'")) return;

  emitProgress("아키텍처 문서 테이블을 doc 유형을 지원하도록 업그레이드합니다.");
  const migrate = db.transaction(() => {
    db.exec("DROP INDEX IF EXISTS architecture_documents_source_index");
    db.exec("DROP INDEX IF EXISTS architecture_documents_embedding_status_index");
    db.exec("ALTER TABLE architecture_documents RENAME TO architecture_documents_legacy");
    db.exec(`
      CREATE TABLE architecture_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        section_index INTEGER NOT NULL,
        heading TEXT NOT NULL,
        doc_type TEXT NOT NULL CHECK (doc_type IN ('context', 'doc', 'adr')),
        body TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB,
        embedding_status TEXT NOT NULL DEFAULT 'missing'
          CHECK (embedding_status IN ('missing', 'ready', 'failed')),
        embedding_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_path, section_index)
      )
    `);
    db.exec(`
      INSERT INTO architecture_documents (
        id, source_path, section_index, heading, doc_type, body, content_hash,
        embedding, embedding_status, embedding_error, created_at, updated_at
      )
      SELECT
        id, source_path, section_index, heading, doc_type, body, content_hash,
        embedding, embedding_status, embedding_error, created_at, updated_at
      FROM architecture_documents_legacy
    `);
    db.exec("DROP TABLE architecture_documents_legacy");
    db.exec("CREATE INDEX architecture_documents_source_index ON architecture_documents(source_path)");
    db.exec("CREATE INDEX architecture_documents_embedding_status_index ON architecture_documents(embedding_status)");
  });
  migrate();
}

function openStore(dbPath) {
  emitProgress(`SQLite 저장소를 엽니다: ${dbPath}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.loadExtension(getExtensionPath());
  db.exec(SCHEMA_SQL);
  ensureArchitectureDocumentSchema(db);
  db.prepare(
    "SELECT vector_init('issues', 'embedding', 'type=FLOAT32,dimension=1024,distance=COSINE')",
  ).get();
  db.prepare(
    "SELECT vector_init('architecture_documents', 'embedding', 'type=FLOAT32,dimension=1024,distance=COSINE')",
  ).get();
  const vectorVersion = db.prepare("SELECT vector_version() AS version").get().version;
  emitProgress(`sqlite-vector ${vectorVersion} 로드 완료 (embedding dimension=${VECTOR_DIMENSION})`);
  return { db, dbPath, vectorVersion };
}

function closeStore(store) {
  if (!store || !store.db.open) return;
  try {
    store.db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    store.db.close();
  }
}

function parseCommand(command) {
  const parts = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) {
    parts.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, "$1"));
  }
  return parts;
}

function defaultEmbeddingPythonCandidates(root, scriptDirectory = __dirname) {
  const venvBin = process.platform === "win32" ? "Scripts" : "bin";
  const pythonName = process.platform === "win32" ? "python.exe" : "python";
  return [
    process.env.ISSUE_EMBEDDING_PYTHON,
    path.join(root, ".venv", venvBin, pythonName),
    path.join(path.dirname(scriptDirectory), ".venv", venvBin, pythonName),
    "python3",
  ].filter(Boolean);
}

function embeddingCommand(root, configuredCommand) {
  const configured = configuredCommand || process.env.ISSUE_EMBEDDING_COMMAND;
  if (!configured) {
    const scriptPath = fs.existsSync(path.join(root, "scripts", "issue-embedding.py"))
      ? path.join(root, "scripts", "issue-embedding.py")
      : path.join(__dirname, "issue-embedding.py");
    const pythonCandidates = defaultEmbeddingPythonCandidates(root);
    const executable = pythonCandidates.find((candidate) => candidate !== "python3" && fs.existsSync(candidate)) || "python3";
    return {
      executable,
      args: [scriptPath],
      cwd: root,
      command: `${JSON.stringify(executable)} ${JSON.stringify(scriptPath)}`,
    };
  }
  const command = configured;
  const parts = parseCommand(command);
  if (parts.length === 0) throw new Error("임베딩 명령이 비어 있습니다.");
  const [executable, ...args] = parts;
  return {
    executable,
    args,
    cwd: root,
    command,
  };
}

function parseEmbeddingOutputs(stdout, expectedCount = 1) {
  const embeddings = [];
  for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const embedding = Array.isArray(value)
      ? value
      : value && (value.embedding || value.vector || value.data);
    if (!Array.isArray(embedding)) continue;
    if (embedding.length !== VECTOR_DIMENSION) {
      throw new Error(`임베딩 차원은 ${VECTOR_DIMENSION}이어야 합니다: ${embedding.length}`);
    }
    if (!embedding.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new Error("임베딩은 유한한 숫자 배열이어야 합니다.");
    }
    embeddings.push(embedding);
  }
  if (embeddings.length !== expectedCount) {
    throw new Error(
      `임베딩 프로세스가 ${expectedCount}개 대신 ${embeddings.length}개의 JSON 배열을 출력했습니다.`,
    );
  }
  return embeddings;
}

function parseEmbeddingOutput(stdout) {
  return parseEmbeddingOutputs(stdout, 1)[0];
}

function runEmbeddingProcess(root, requests, configuredCommand) {
  const invocation = embeddingCommand(root, configuredCommand);
  emitProgress(`임베딩 프로세스를 실행합니다: ${invocation.command}`);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: invocation.cwd,
    input: requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.stderr) {
    for (const line of String(result.stderr).split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      emitProgress(`embedding: ${line}`);
    }
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    const labels = requests.map((request) => request._embedding_label).filter(Boolean);
    const scope = labels.length ? ` 대상: ${labels.join(", ")}` : "";
    throw new Error(`임베딩 프로세스가 실패했습니다(${result.status})${scope}: ${detail}`);
  }
  emitProgress("임베딩 생성 프로세스가 완료되었습니다.");
  return parseEmbeddingOutputs(String(result.stdout || ""), requests.length);
}

function createEmbedding(root, text, configuredCommand) {
  return runEmbeddingProcess(root, [{ text }], configuredCommand)[0];
}

function createEmbeddings(root, texts, configuredCommand, labels = []) {
  const requests = texts.map((text, index) => ({
    text,
    _embedding_index: index + 1,
    _embedding_total: texts.length,
    _embedding_label: labels[index] || "",
  }));
  return runEmbeddingProcess(root, requests, configuredCommand);
}

function vectorJson(embedding) {
  return JSON.stringify(embedding);
}

function bodyForEmbedding(issue) {
  return [
    issue.issue_id,
    issue.triage_label || "",
    issue.title,
    issue.body,
    issue.parent_issue_id || "",
    ...(issue.blockedBy || []),
  ].filter(Boolean).join("\n\n");
}

function architectureDocumentFiles(root) {
  const files = [];
  const contextPath = path.join(root, "CONTEXT.md");
  if (fs.existsSync(contextPath)) files.push(contextPath);

  const docsDirectory = path.join(root, "docs");
  if (fs.existsSync(docsDirectory)) {
    for (const entry of fs.readdirSync(docsDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(docsDirectory, entry.name));
      }
    }
  }

  const adrDirectory = path.join(root, "docs", "adr");
  if (fs.existsSync(adrDirectory)) {
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(filePath);
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(filePath);
      }
    };
    walk(adrDirectory);
  }
  return files.sort();
}

function architectureSections(markdown) {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)];
  if (headings.length === 0) {
    return [{ heading: "Document", body: markdown.trim() }];
  }
  return headings.map((heading, index) => {
    const start = heading.index || 0;
    const end = headings[index + 1]?.index || markdown.length;
    return {
      heading: heading[2].trim(),
      body: markdown.slice(start, end).trim(),
    };
  });
}

function architectureChunks(root, filePath) {
  const markdown = fs.readFileSync(filePath, "utf8");
  const sourcePath = path.relative(root, filePath);
  const adrDirectory = path.join(root, "docs", "adr");
  const docType = path.basename(filePath) === "CONTEXT.md"
    ? "context"
    : filePath.startsWith(`${adrDirectory}${path.sep}`)
      ? "adr"
      : "doc";
  return architectureSections(markdown).map((section, sectionIndex) => {
    const searchableBody = [sourcePath, section.heading, section.body].join("\n\n");
    return {
      source_path: sourcePath,
      section_index: sectionIndex,
      heading: section.heading,
      doc_type: docType,
      body: section.body,
      content_hash: crypto.createHash("sha256").update(searchableBody).digest("hex"),
      searchable_body: searchableBody,
    };
  });
}

function formatArchitectureDocument(row, distance) {
  const document = {
    source_path: row.source_path,
    section_index: row.section_index,
    heading: row.heading,
    doc_type: row.doc_type,
    body: row.body,
    content_hash: row.content_hash,
    embedding_status: row.embedding_status,
    embedding_error: row.embedding_error,
    embedding_bytes: row.embedding ? row.embedding.length : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (distance !== undefined) document.distance = distance;
  return document;
}

function upsertArchitectureDocument(store, chunk, embedding, error = null) {
  const timestamp = now();
  const embeddingStatus = embedding ? "ready" : "failed";
  const sql = `
    INSERT INTO architecture_documents (
      source_path, section_index, heading, doc_type, body, content_hash,
      embedding, embedding_status, embedding_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ${embedding ? "vector_as_f32(?)" : "NULL"}, ?, ?, ?, ?)
    ON CONFLICT(source_path, section_index) DO UPDATE SET
      heading = excluded.heading,
      doc_type = excluded.doc_type,
      body = excluded.body,
      content_hash = excluded.content_hash,
      embedding = excluded.embedding,
      embedding_status = excluded.embedding_status,
      embedding_error = excluded.embedding_error,
      updated_at = excluded.updated_at
  `;
  const statement = store.db.prepare(sql);
  if (embedding) {
    statement.run(
      chunk.source_path,
      chunk.section_index,
      chunk.heading,
      chunk.doc_type,
      chunk.body,
      chunk.content_hash,
      vectorJson(embedding),
      embeddingStatus,
      null,
      timestamp,
      timestamp,
    );
  } else {
    statement.run(
      chunk.source_path,
      chunk.section_index,
      chunk.heading,
      chunk.doc_type,
      chunk.body,
      chunk.content_hash,
      embeddingStatus,
      error,
      timestamp,
      timestamp,
    );
  }
}

function indexArchitectureDocuments(store, options) {
  const files = architectureDocumentFiles(options.root);
  const chunks = files.flatMap((filePath) => architectureChunks(options.root, filePath));
  const existing = store.db.prepare("SELECT * FROM architecture_documents ORDER BY id").all();
  const existingByKey = new Map(
    existing.map((row) => [`${row.source_path}:${row.section_index}`, row]),
  );
  const desiredKeys = new Set(
    chunks.map((chunk) => `${chunk.source_path}:${chunk.section_index}`),
  );
  const stale = existing.filter(
    (row) => !desiredKeys.has(`${row.source_path}:${row.section_index}`),
  );
  const pending = chunks.filter((chunk) => {
    const row = existingByKey.get(`${chunk.source_path}:${chunk.section_index}`);
    return !row || row.content_hash !== chunk.content_hash || row.embedding_status !== "ready";
  });

  emitProgress(`아키텍처 문서 ${files.length}개, section ${chunks.length}개를 확인합니다.`);
  let embeddings = [];
  let embeddingError = null;
  if (pending.length > 0) {
    try {
      embeddings = createEmbeddings(
        options.root,
        pending.map((chunk) => chunk.searchable_body),
        options.embeddingCommand,
        pending.map((chunk) => `${chunk.source_path}#${chunk.heading}`),
      );
    } catch (error) {
      embeddingError = error instanceof Error ? error.message : String(error);
      emitProgress(`아키텍처 문서 임베딩 실패; 원문은 저장합니다: ${embeddingError}`);
    }
  }

  const embeddingByKey = new Map(
    pending.map((chunk, index) => [
      `${chunk.source_path}:${chunk.section_index}`,
      embeddings[index],
    ]),
  );
  const transaction = store.db.transaction(() => {
    for (const row of stale) {
      store.db
        .prepare("DELETE FROM architecture_documents WHERE source_path = ? AND section_index = ?")
        .run(row.source_path, row.section_index);
    }
    for (const chunk of chunks) {
      const key = `${chunk.source_path}:${chunk.section_index}`;
      const existingRow = existingByKey.get(key);
      if (
        existingRow &&
        existingRow.content_hash === chunk.content_hash &&
        existingRow.embedding_status === "ready"
      ) {
        continue;
      }
      upsertArchitectureDocument(store, chunk, embeddingByKey.get(key), embeddingError);
    }
  });
  transaction();

  const failed = pending.filter((chunk) => !embeddingByKey.get(`${chunk.source_path}:${chunk.section_index}`));
  emitProgress(
    `아키텍처 문서 색인 완료: ${pending.length - failed.length}개 임베딩, ${failed.length}개 실패, ${stale.length}개 제거.`,
  );
  return {
    files: files.map((file) => path.relative(options.root, file)),
    document_count: chunks.length,
    embedded_count: pending.length - failed.length,
    failed_count: failed.length,
    removed_count: stale.length,
    failed_documents: failed.map((chunk) => `${chunk.source_path}#${chunk.heading}`),
  };
}

function searchArchitectureDocuments(store, options) {
  const query = String(options.query || options.q || options.positionals?.[0] || "").trim();
  if (!query) throw new Error("architecture search query가 필요합니다.");
  const limit = Math.max(1, Math.min(Number(options.limit || 8), 50));
  emitProgress("아키텍처 검색어 임베딩 생성을 시작합니다.");
  const embedding = createEmbedding(options.root, query, options.embeddingCommand);
  const rows = store.db.prepare(`
    SELECT v.rowid, v.distance
    FROM vector_full_scan('architecture_documents', 'embedding', vector_as_f32(?)) AS v
    JOIN architecture_documents AS d ON d.id = v.rowid
    WHERE d.embedding_status = 'ready'
    ORDER BY v.distance ASC
    LIMIT ?
  `).all(vectorJson(embedding), limit);
  emitProgress(`아키텍처 문서 검색 완료: ${rows.length}개 결과.`);
  return rows.map((row) =>
    formatArchitectureDocument(
      store.db.prepare("SELECT * FROM architecture_documents WHERE id = ?").get(row.rowid),
      row.distance,
    ),
  );
}

function validateIssueId(issueId) {
  if (!ISSUE_ID_PATTERN.test(issueId)) {
    throw new Error(`issue_id는 T-### 형식이어야 합니다: ${issueId}`);
  }
}

function validateStatus(status) {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`status는 backlog/current/done 중 하나여야 합니다: ${status}`);
  }
}

function normalizeIds(value) {
  if (value == null || value === "") return [];
  const values = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const ids = values.filter(Boolean);
  ids.forEach(validateIssueId);
  return [...new Set(ids)];
}

function nextIssueId(db) {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(issue_id, 3) AS INTEGER)) AS max_number FROM issues").get();
  return `T-${String((row.max_number || 0) + 1).padStart(3, "0")}`;
}

function issueRow(db, issueId) {
  validateIssueId(issueId);
  return db.prepare("SELECT * FROM issues WHERE issue_id = ?").get(issueId);
}

function blockersFor(db, issueId) {
  return db.prepare(
    "SELECT blocker_issue_id FROM issue_blockers WHERE issue_id = ? ORDER BY blocker_issue_id",
  ).all(issueId).map((row) => row.blocker_issue_id);
}

function formatIssue(db, row, distance) {
  if (!row) return null;
  const issue = {
    issue_id: row.issue_id,
    triage_label: row.triage_label,
    label: row.triage_label,
    title: row.title,
    status: row.status,
    parent: row.parent_issue_id,
    parent_issue_id: row.parent_issue_id,
    blockedBy: blockersFor(db, row.issue_id),
    blocked_by: blockersFor(db, row.issue_id),
    body: row.body,
    embedding_status: row.embedding_status,
    embedding_error: row.embedding_error,
    embedding_bytes: row.embedding ? row.embedding.length : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (distance !== undefined) issue.distance = distance;
  return issue;
}

function insertIssue(
  store,
  input,
  options,
  issueId = input.issue_id || nextIssueId(store.db),
  precomputedEmbedding,
) {
  const { db } = store;
  validateIssueId(issueId);
  const title = String(input.title || "").trim();
  if (!title) throw new Error("title이 필요합니다.");
  const body = String(input.body || "");
  const status = input.status || "backlog";
  validateStatus(status);
  const triageLabel = input.triage_label ?? input.label ?? null;
  const parent = input.parent_issue_id ?? input.parent ?? null;
  if (parent) validateIssueId(parent);
  const blockedBy = normalizeIds(input.blockedBy ?? input.blocked_by ?? input.blockedByIds);
  const issue = {
    issue_id: issueId,
    triage_label: triageLabel,
    title,
    status,
    body,
    parent_issue_id: parent,
    blockedBy,
  };

  let embedding = null;
  let embeddingStatus = "missing";
  let embeddingError = null;
  if (precomputedEmbedding !== undefined) {
    embedding = precomputedEmbedding;
    embeddingStatus = "ready";
    emitProgress(`${issueId} 사전 검증된 임베딩을 사용합니다.`);
  } else {
    emitProgress(`${issueId} 임베딩 생성을 시작합니다.`);
    try {
      embedding = createEmbedding(options.root, bodyForEmbedding(issue), options.embeddingCommand);
      embeddingStatus = "ready";
      emitProgress(`${issueId} 임베딩 준비 완료.`);
    } catch (error) {
      embeddingStatus = "failed";
      embeddingError = error instanceof Error ? error.message : String(error);
      emitProgress(`${issueId} 임베딩 실패; 원문 저장을 계속합니다: ${embeddingError}`);
    }
  }

  const timestamp = now();
  const insert = db.prepare(`
    INSERT INTO issues (
      issue_id, triage_label, title, status, body, embedding,
      embedding_status, embedding_error, parent_issue_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ${embedding ? "vector_as_f32(?)" : "NULL"}, ?, ?, ?, ?, ?)
  `);
  const blockerInsert = db.prepare(
    "INSERT OR IGNORE INTO issue_blockers (issue_id, blocker_issue_id) VALUES (?, ?)",
  );
  const transaction = db.transaction(() => {
    if (embedding) {
      insert.run(
        issueId,
        triageLabel,
        title,
        status,
        body,
        vectorJson(embedding),
        embeddingStatus,
        embeddingError,
        parent,
        timestamp,
        timestamp,
      );
    } else {
      insert.run(
        issueId,
        triageLabel,
        title,
        status,
        body,
        embeddingStatus,
        embeddingError,
        parent,
        timestamp,
        timestamp,
      );
    }
    for (const blocker of blockedBy) blockerInsert.run(issueId, blocker);
  });
  transaction();
  emitProgress(`${issueId} SQLite 저장 완료 (embedding_status=${embeddingStatus}).`);
  return formatIssue(db, issueRow(db, issueId));
}

function updateStatus(store, issueId, status) {
  validateStatus(status);
  emitProgress(`${issueId} 상태를 ${status}(으)로 변경합니다.`);
  const row = issueRow(store.db, issueId);
  if (!row) throw new Error(`이슈를 찾을 수 없습니다: ${issueId}`);
  store.db.prepare("UPDATE issues SET status = ?, updated_at = ? WHERE issue_id = ?").run(status, now(), issueId);
  emitProgress(`${issueId} SQLite 상태 변경 완료.`);
  return formatIssue(store.db, issueRow(store.db, issueId));
}

function updateEmbedding(store, row, embedding, error = null) {
  const timestamp = now();
  if (embedding) {
    store.db.prepare(
      "UPDATE issues SET embedding = vector_as_f32(?), embedding_status = 'ready', embedding_error = NULL, updated_at = ? WHERE issue_id = ?",
    ).run(vectorJson(embedding), timestamp, row.issue_id);
  } else {
    store.db.prepare(
      "UPDATE issues SET embedding = NULL, embedding_status = 'failed', embedding_error = ?, updated_at = ? WHERE issue_id = ?",
    ).run(error, timestamp, row.issue_id);
  }
}

function reembedFailed(store, options) {
  const rows = store.db.prepare(
    "SELECT * FROM issues WHERE embedding_status IN ('failed', 'missing') ORDER BY id",
  ).all();
  emitProgress(`재임베딩 대상 ${rows.length}개를 읽었습니다.`);
  if (rows.length === 0) return [];

  const labels = rows.map((row) => row.issue_id);
  const inputs = rows.map((row) => bodyForEmbedding({
    issue_id: row.issue_id,
    triage_label: row.triage_label,
    title: row.title,
    body: row.body,
    parent_issue_id: row.parent_issue_id,
    blockedBy: blockersFor(store.db, row.issue_id),
  }));
  let embeddings;
  let failure = null;
  try {
    emitProgress(`재임베딩을 한 프로세스로 처리합니다: ${rows.length}개.`);
    embeddings = createEmbeddings(options.root, inputs, options.embeddingCommand, labels);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    emitProgress(`일괄 재임베딩 실패: ${failure}`);
  }

  const results = [];
  for (const [index, row] of rows.entries()) {
    const embedding = embeddings?.[index];
    updateEmbedding(store, row, embedding, failure);
    emitProgress(
      embedding
        ? `${row.issue_id} 재임베딩 및 SQLite 갱신 완료.`
        : `${row.issue_id} 재임베딩 실패: ${failure}`,
    );
    results.push(formatIssue(store.db, issueRow(store.db, row.issue_id)));
  }
  return results;
}

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## [^\\n]+\\n|$)`, "i");
  return markdown.match(pattern)?.[1]?.trim() || "";
}

function extractTaskIds(markdown, heading) {
  return [...sectionBody(markdown, heading).matchAll(/-\s*(T-\d{3})\b/g)].map((match) => match[1]);
}

function inferStatus(filePath, raw) {
  if (filePath.includes(`${path.sep}archive${path.sep}`)) return "done";
  if (filePath.endsWith(`${path.sep}current.md`)) return "current";
  const match = raw.match(/\*\*Status:\*\*\s*(backlog|in-progress|done)\b/i);
  const value = match?.[1]?.toLowerCase();
  return value === "in-progress" ? "current" : value || "backlog";
}

function parseMarkdownFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const headers = [...text.matchAll(/^###\s+(T-\d{3})\s+(?:\[([^\]]+)\]\s+)?(.+?)\s*$/gm)];
  return headers.map((header, index) => {
    const start = header.index || 0;
    const end = headers[index + 1]?.index || text.length;
    const raw = text.slice(start, end).trim();
    return {
      issue_id: header[1],
      triage_label: header[2] || null,
      title: header[3].trim(),
      status: inferStatus(filePath, raw),
      body: raw,
      source_file: filePath,
      parent_issue_id: extractTaskIds(raw, "Parent")[0] || null,
      blockedBy: extractTaskIds(raw, "Blocked by"),
    };
  });
}

function markdownIssueFiles(root) {
  const tasks = path.join(root, "docs", "tasks");
  const files = [];
  for (const relative of ["backlog.md", "current.md"]) {
    const filePath = path.join(tasks, relative);
    if (fs.existsSync(filePath)) files.push(filePath);
  }
  const archive = path.join(tasks, "archive");
  if (fs.existsSync(archive)) {
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(filePath);
        else if (entry.isFile() && entry.name.endsWith(".md")) files.push(filePath);
      }
    };
    walk(archive);
  }
  return files.sort();
}

function migrate(store, options) {
  const sourceFiles = markdownIssueFiles(options.root);
  emitProgress(`Markdown 이슈 ${sourceFiles.length}개 파일을 읽습니다.`);
  const parsed = sourceFiles.flatMap(parseMarkdownFile);
  const unique = new Map(parsed.map((issue) => [issue.issue_id, issue]));
  const candidates = [...unique.values()].filter((issue) => !issueRow(store.db, issue.issue_id));
  emitProgress(
    `마이그레이션 대상 ${candidates.length}개 이슈를 찾았습니다 (${unique.size - candidates.length}개는 이미 저장됨).`,
  );
  const pending = [];
  const labels = candidates.map(
    (issue) => `${path.relative(options.root, issue.source_file)} → ${issue.issue_id} (${issue.title})`,
  );
  let embeddings = [];
  if (candidates.length > 0) {
    emitProgress(`임베딩 사전 검증을 시작합니다: ${candidates.length}개 이슈를 한 프로세스로 처리합니다.`);
    try {
      embeddings = createEmbeddings(
        options.root,
        candidates.map((issue) => bodyForEmbedding(issue)),
        options.embeddingCommand,
        labels,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`마이그레이션을 중단했습니다. 임베딩 사전 검증에 실패했습니다: ${message}`);
    }
  }
  for (const [index, issue] of candidates.entries()) {
    pending.push({ issue, embedding: embeddings[index] });
    emitProgress(`[임베딩 ${index + 1}/${candidates.length}] ${labels[index]} 완료`);
  }

  const migrated = [];
  const skipped = [];
  for (const issue of unique.values()) {
    if (issueRow(store.db, issue.issue_id)) {
      skipped.push(issue.issue_id);
      emitProgress(`${path.relative(options.root, issue.source_file)} → ${issue.issue_id}는 이미 SQLite에 있어 건너뜁니다.`);
      continue;
    }
    const prepared = pending.find((item) => item.issue.issue_id === issue.issue_id);
    emitProgress(
      `[SQLite 저장 ${migrated.length + 1}/${candidates.length}] ${path.relative(options.root, issue.source_file)} → ${issue.issue_id} 시작`,
    );
    migrated.push(insertIssue(store, issue, options, issue.issue_id, prepared.embedding));
    emitProgress(
      `[SQLite 저장 ${migrated.length}/${candidates.length}] ${path.relative(options.root, issue.source_file)} → ${issue.issue_id} 완료`,
    );
  }
  emitProgress(`Markdown 마이그레이션 완료: ${migrated.length}개 저장, ${skipped.length}개 건너뜀.`);
  return { migrated, skipped, source_files: sourceFiles.map((file) => path.relative(options.root, file)) };
}

function pruneMigratedMarkdown(store, options) {
  const sourceFiles = markdownIssueFiles(options.root);
  const parsed = sourceFiles.flatMap(parseMarkdownFile);
  const unique = new Map(parsed.map((issue) => [issue.issue_id, issue]));
  const missing = [...unique.keys()].filter((issueId) => !issueRow(store.db, issueId));
  if (missing.length > 0) {
    throw new Error(`SQLite에 없는 Markdown 이슈가 있어 축약을 중단합니다: ${missing.join(", ")}`);
  }
  if (!options.yes) {
    throw new Error("Markdown 축약은 데이터 손실을 수반하므로 --yes 확인이 필요합니다.");
  }

  const pruned = [];
  for (const filePath of sourceFiles) {
    const original = fs.readFileSync(filePath, "utf8");
    if (!/^###\s+T-\d{3}\b/m.test(original)) continue;
    const firstIssue = original.search(/^###\s+T-\d{3}\b/m);
    const preamble = firstIssue >= 0 ? original.slice(0, firstIssue).trimEnd() : "";
    const title = preamble || `# ${path.basename(filePath, ".md")}`;
    const replacement = [
      title,
      "",
      "> 이 파일의 T-### 이슈 source of truth는 `docs/issues.sqlite`입니다.",
      "> 기존 Markdown 본문은 SQLite로 마이그레이션되었으며 Git history에서 확인할 수 있습니다.",
      "> 새 이슈 발행·조회·상태 변경은 agent 설치 위치의 `scripts/issue-store.js` CLI에 `--root`를 넘겨 수행하세요.",
      "",
    ].join("\n");
    fs.writeFileSync(filePath, replacement, "utf8");
    pruned.push(path.relative(options.root, filePath));
  }
  emitProgress(`마이그레이션된 Markdown ${pruned.length}개 파일을 source-of-truth 안내문으로 축약했습니다.`);
  return {
    pruned_files: pruned,
    issue_count: unique.size,
  };
}

function listIssues(store, options) {
  emitProgress("SQLite 이슈 목록을 읽습니다.");
  const clauses = [];
  const values = [];
  if (options.status) {
    validateStatus(options.status);
    clauses.push("status = ?");
    values.push(options.status);
  }
  if (options.label || options.triage_label) {
    clauses.push("triage_label = ?");
    values.push(options.label || options.triage_label);
  }
  if (options.parent || options.parent_issue_id) {
    const parent = options.parent || options.parent_issue_id;
    validateIssueId(parent);
    clauses.push("parent_issue_id = ?");
    values.push(parent);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = store.db.prepare(`SELECT * FROM issues ${where} ORDER BY id`).all(...values);
  emitProgress(`SQLite 이슈 목록 읽기 완료: ${rows.length}개.`);
  return rows.map((row) => formatIssue(store.db, row));
}

function searchIssues(store, options) {
  const query = String(options.query || options.q || options.positionals?.[0] || "").trim();
  if (!query) throw new Error("search query가 필요합니다.");
  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
  emitProgress("검색어 임베딩 생성을 시작합니다.");
  const embedding = createEmbedding(options.root, query, options.embeddingCommand);
  emitProgress("ready 임베딩만 대상으로 sqlite-vector 검색을 실행합니다.");
  const rows = store.db.prepare(`
    SELECT v.rowid, v.distance
    FROM vector_full_scan('issues', 'embedding', vector_as_f32(?)) AS v
    JOIN issues AS i ON i.id = v.rowid
    WHERE i.embedding_status = 'ready'
    ORDER BY v.distance ASC
    LIMIT ?
  `).all(vectorJson(embedding), limit);
  emitProgress(`sqlite-vector 검색 완료: ${rows.length}개 결과.`);
  return rows.map((row) => formatIssue(store.db, issueRowByRowId(store.db, row.rowid), row.distance));
}

function issueRowByRowId(db, id) {
  return db.prepare("SELECT * FROM issues WHERE id = ?").get(id);
}

function parseArgs(argv) {
  const [command = "help", ...tokens] = argv;
  const options = { command, positionals: [] };
  const setOption = (name, value) => {
    options[name] = value;
    const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    options[camelName] = value;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      options.positionals.push(token);
      continue;
    }
    const withoutPrefix = token.slice(2);
    const equals = withoutPrefix.indexOf("=");
    if (equals >= 0) {
      setOption(withoutPrefix.slice(0, equals), withoutPrefix.slice(equals + 1));
      continue;
    }
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      setOption(withoutPrefix, next);
      index += 1;
    } else {
      setOption(withoutPrefix, true);
    }
  }
  return options;
}

function readJsonPayload(options) {
  if (!options.json) return {};
  const input = fs.readFileSync(0, "utf8").trim();
  return input ? JSON.parse(input) : {};
}

function optionsWithPayload(options) {
  return { ...options, ...readJsonPayload(options) };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(error) {
  print({ ok: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

function removeDatabaseFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // Best effort cleanup after a failed first migration.
    }
  }
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = parsed.command;
  const root = path.resolve(parsed.root || process.cwd());
  const dbPath = resolveDbPath(root, parsed.db);
  const databaseExistedBefore = fs.existsSync(dbPath);
  let store;
  try {
    if (command === "help") {
      print({ ok: true, commands: ["init", "migrate", "index-architecture", "prune-migrated", "create", "get", "list", "update-status", "search", "search-architecture", "reembed-failed"] });
      return;
    }
    store = openStore(dbPath);
    const options = optionsWithPayload({ ...parsed, root });
    if (command === "init") {
      print({ ok: true, command, db_path: dbPath, vector: { loaded: true, version: store.vectorVersion, dimension: VECTOR_DIMENSION }, schema: ["issues", "issue_blockers", "architecture_documents"] });
      return;
    }
    if (command === "migrate") {
      const result = migrate(store, options);
      print({ ok: true, command, ...result, count: result.migrated.length, issues: result.migrated });
      return;
    }
    if (command === "index-architecture") {
      const result = indexArchitectureDocuments(store, options);
      print({ ok: true, command, ...result });
      return;
    }
    if (command === "prune-migrated") {
      const result = pruneMigratedMarkdown(store, options);
      print({ ok: true, command, ...result });
      return;
    }
    if (command === "create") {
      const input = options;
      const issue = insertIssue(store, input, options);
      print({ ok: true, command, ...issue, issue });
      return;
    }
    if (command === "get") {
      const issueId = parsed.issue_id || parsed.issueId || parsed.positionals[0];
      emitProgress(`${issueId} SQLite 문서를 읽습니다.`);
      const issue = formatIssue(store.db, issueRow(store.db, issueId));
      if (!issue) throw new Error(`이슈를 찾을 수 없습니다: ${issueId}`);
      print({ ok: true, command, ...issue, issue });
      return;
    }
    if (command === "list") {
      const issues = listIssues(store, options);
      print({ ok: true, command, count: issues.length, issues });
      return;
    }
    if (command === "update-status") {
      const issueId = parsed.issue_id || parsed.issueId || parsed.positionals[0];
      const status = parsed.status || parsed.positionals[1];
      const issue = updateStatus(store, issueId, status);
      print({ ok: true, command, ...issue, issue });
      return;
    }
    if (command === "search") {
      const results = searchIssues(store, options);
      print({ ok: true, command, query: options.query || options.q || options.positionals[0], count: results.length, results });
      return;
    }
    if (command === "search-architecture") {
      const results = searchArchitectureDocuments(store, options);
      print({ ok: true, command, query: options.query || options.q || options.positionals[0], count: results.length, results });
      return;
    }
    if (command === "reembed-failed") {
      const results = reembedFailed(store, options);
      print({ ok: true, command, count: results.length, issues: results });
      return;
    }
    throw new Error(`알 수 없는 명령입니다: ${command}`);
  } catch (error) {
    if (command === "migrate" && !databaseExistedBefore) removeDatabaseFiles(dbPath);
    fail(error);
  } finally {
    closeStore(store);
  }
}

if (require.main === module) run();

module.exports = {
  VECTOR_DIMENSION,
  SCHEMA_SQL,
  parseArgs,
  parseMarkdownFile,
  defaultEmbeddingPythonCandidates,
  chooseEmbeddingCommand: embeddingCommand,
  parseEmbeddingOutput,
  bodyForEmbedding,
  architectureDocumentFiles,
  architectureSections,
  architectureChunks,
  indexArchitectureDocuments,
  searchArchitectureDocuments,
  pruneMigratedMarkdown,
  openStore,
  closeStore,
  run,
};
