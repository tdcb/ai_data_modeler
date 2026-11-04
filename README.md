# AI Data Modeler

> **AI-native data modeling for SQL Server, SQLite, Snowflake and dbt — built on MetaForge Studio**

AI Data Modeler extends MetaForge Studio with an Archibase-style, AI-first workflow: four synchronized interfaces
(Canvas, AI Companion, Dictionary, Editor), model generation from unstructured context, natural-language schema search,
AI documentation and a privacy-first, metadata-only boundary. Pick the LLM per request: **Kiro CLI**, **Gemini CLI**,
**Devin** (Devin cloud API), the Google Gemini API, any OpenAI-compatible API, or the built-in offline engine.

## AI-native features

| Feature | Where | How it works |
|---|---|---|
| **Four synced interfaces** | View switcher above the canvas: *Canvas*, *Dictionary*, *Editor*, *Canvas + Editor*; *AI Companion* side panel | All four read and write the same Zustand canonical model, so an edit in one shows up in the others straight away (undo/redo works across all of them). |
| **Canvas** | `ERDCanvas`, `TableNode` | Add/rename/drop tables and columns inline, toggle PK/FK/nullability, change data types, drag to connect FKs. Dictionary/search results zoom the canvas to the matching entity. |
| **Editor** | `components/editor/ModelEditor.tsx`, `backend/app/ai/editor_dsl.py` | A DBML-style text view (`Table`, columns with `[pk, not null, unique, pii:, note:]`, `Ref a.x < b.y [1:N]`). Live sync applies edits while you type (or Ctrl/Cmd+S). Tables and columns are matched by name, so ids, positions and all other properties are kept. Errors are shown with line numbers. |
| **Dictionary** | `components/dictionary/DataDictionary.tsx` | Every table, column, relationship and glossary term with inline-editable names, types, keys, PII labels and definitions, documentation coverage, plus an AI *Explain* for each object. |
| **AI Companion** | `components/ai/AICompanion.tsx` | Tabs: **Chat** (ask questions or ask for model changes; changes are applied to the shared model), **Generate**, **Search**, **Document**, **Context**, **Privacy**. |
| **Generate from unstructured context** | `/api/ai/generate`, `ai/generator.py`, `ai/textmodel.py` | Notes, transcripts (.vtt/.srt), briefs, requirements, .docx/.pdf, SQL DDL, DBML, Mermaid `erDiagram`, markdown tables and diagram images (sent to multimodal providers). You review a preview of new and extended tables before merging. Works offline with a built-in extractor. |
| **Natural-language search** | `/api/ai/search`, `ai/search.py` | Matches on synonyms, glossary abbreviations and structure ("PII columns", "date columns in claims", "tables without description", "foreign keys to customer"). It can optionally send the question to the LLM. |
| **AI documentation** | `/api/ai/document`, `/api/ai/explain`, `ai/documenter.py` | Drafts definitions for tables, columns and relationships. You review and edit each one before applying, and applied ones are marked `AUTO_GENERATED`. |
| **Context library** | `/api/ai/context*`, `ai/context_library.py` | Project documents the AI uses as background. Stored under `workspace_model/context_library/` (gitignored). |
| **Privacy-first metadata** | `ai/privacy.py`, *Privacy* tab | Metadata-only mode is **on by default**. Reverse engineering reads only structure (no `COUNT(*)`), live profiling is turned off, file imports drop sample values, and AI prompts are built only from `ai_catalog()`: names, types, keys, constraints, indexes, views and descriptions. Row data, samples, min/max and credentials are never sent. Every external AI call is logged to `workspace_model/ai_audit.jsonl` (size and feature only). Only admins can turn the mode off. |
| **SQLite DDL** | `compilers/sqlite.py`, *DDL & dbt* drawer | Joins the existing Snowflake / SQL Server / Oracle / dbt / data-contract outputs. |

### LLM providers

| Provider | Type | Default command / settings |
|---|---|---|
| Built-in (offline) | deterministic | no LLM; nothing leaves the machine |
| **Kiro CLI** | headless CLI | `kiro-cli chat --no-interactive` (+ `--model`) |
| **Gemini CLI** | headless CLI | `gemini -p …` (prompt streamed on stdin, `-m` model) |
| **Devin** | Devin cloud API | starts a Devin session (`POST /v1/sessions`) that analyses the request against the model metadata and replies with the answer / proposed model changes; API key, API base URL, max ACUs and timeout are all set in the AI panel's provider settings (gear icon; the key is stored server-side in `workspace_model/ai_secrets.json` and shown masked). `DEVIN_API_KEY` in the environment still works as a fallback |
| Google Gemini API | HTTPS | per-user key (Profile → AI API Keys) or `GEMINI_API_KEY` |
| OpenAI-compatible | HTTPS | base URL, model and API key set in the AI panel's provider settings (env `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` as fallback) |

Kiro CLI and Gemini CLI run on the machine that hosts the backend and use that machine's existing CLI login, so no API key
is needed. Choose a provider in the AI Companion header. The gear icon lets you edit the command/model/timeout,
**Test** the provider, and **Save as default** (saved to `workspace_model/ai_settings.json`, gitignored). If a
provider fails or isn't installed, the request falls back to the built-in engine and shows a warning.

---

# MetaForge Studio foundation

> **Enterprise Cloud-Native Canonical Data Modeling, Governance Control Plane & Remote Collaboration Repository**

MetaForge Studio is an enterprise-grade data modeling and governance platform designed for modern data engineering, analytics architecture, and autonomous data stewardship. It bridges conceptual, logical, and physical modeling with multi-dialect DDL compilation, live database reverse engineering, automated data profiling, AI-assisted business metadata synthesis, Model Context Protocol (MCP) coding assistant integration, and a distributed check-in/check-out remote repository with 3-way conflict resolution.

---

## Real-time collaboration

Everyone who opens the same model (the local workspace or a shared repository model) joins a live room over a WebSocket (`/api/collab/ws/{model_id}`).

- **Live editing:** every change made in the Canvas, Dictionary, Editor or AI Companion is sent to the server, given the next model version and pushed to everyone else within a second. Changes are merged per table: edits to different tables never clash. If two people change the same table at the same moment, the later one is kept and both are told. Undo/redo only reverts your own edits.
- **Presence:** avatars in the toolbar show who is in the model, their role and which view they are using. The table each person has selected is outlined in their colour on the Canvas and marked in the Dictionary.
- **Comments:** threads on a table, column, relationship or the whole model, with replies, `@name` / `@email` mentions and resolve/reopen. Open threads show as badges on Canvas tables and in the Dictionary. The Comments tab lists open and resolved threads.
- **Sharing:** the Share button lets an Owner invite people by email or create a share link, with the role Owner, Editor, Commenter or Viewer. Roles are stored in the existing per-model access list (`ADMIN` / `EDIT` / `COMMENT` / `VIEW`). Viewers cannot edit; Commenters can comment but not edit.
- **Activity & history:** the Activity tab lists who changed, commented on or shared the model and when. Each edit keeps a snapshot (the last 200 per model), and an Editor or Owner can restore the model to any of them. A restore is itself an audited activity entry.

Repository models that are checked out through the governed check-out / check-in workflow stay locked to their owner; live edits from anyone else are rejected until check-in. Collaboration traffic carries model metadata only — never row data.

## Key Capabilities

- **Tri-Level Model Duality**: Seamlessly toggle between **Conceptual**, **Logical**, and **Physical** representations with automated glossary abbreviation mapping, domain cascading, and foreign key inference.
- **Multi-Dialect Physical Compilation**: Generate native, production-ready DDL for **Snowflake Data Cloud**, **Microsoft SQL Server (T-SQL)**, and **Oracle Database (PL/SQL)**, alongside **dbt** projects (`schema.yml`, `sources.yml`, and SQL staging models) and **Open Data Contract Standard (ODCS)** YAML contracts.
- **Reverse Engineering & Sync**:
  - **Live Databases & SQLite**: Connect directly to SQLite, Snowflake, SQL Server, PostgreSQL, or Oracle; inspect multi-zone architectures (Staging, DWH / Core, Consumption); run statistical column profiling; and push synthesized business metadata back to the target database.
  - **File Ingestion**: Reverse engineer multi-sheet Excel workbooks (`.xlsx`, `.xls`) and CSV files with relational constraint detection.
  - **DDL Parser & Complete Compare**: Parse complex DDL and CTE view queries into canvas entities, compare canvas metamodels against target databases, and generate non-destructive `ALTER` migration scripts.
- **Shared Remote Repository & Check-In / Check-Out Governance**:
  - **Standalone (Local) vs. Remote Mode**: Work locally in Standalone mode with full offline editing, or connect to a shared enterprise repository.
  - **View-Only Without Checkout**: Inspect shared models in read-only mode without locking the repository.
  - **Check-Out & Locking**: Download working drafts locally and lock the model in the shared repository so concurrent editors cannot overwrite changes.
  - **Admin Force-Release & Stale Check-In Denial**: Administrators can force-release abandoned locks, automatically denying stale check-ins while safely preserving the editor's draft.
  - **3-Way Non-Conflicting Auto-Reapply**: Automatically merges non-conflicting additions, alterations, and new tables back onto the latest remote version when the model becomes available again.
  - **User-Based Access Control (ACL)**: Model-level permission matrix (`ADMIN`, `EDIT`, `VIEW`, `NONE`) managed by administrators.
- **Autonomous Governance & AI Synthesis**:
  - Synthesize rich, standardized business descriptions for tables and columns by feeding statistical profiling metrics into Google Gemini.
  - Private per-user API key management stored securely in the local SQLite database and client storage—never hardcoded or committed to version control.
- **Model Context Protocol (MCP) Integration**:
  - Built-in MCP 2024-11-05 JSON-RPC server (`mcp_server.py` and HTTP endpoints at `/api/mcp`) exposing tools, resources, and prompt templates to AI coding assistants (Claude Code, Cursor, Gemini CLI).

---

## Architecture Overview

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │                      MetaForge Studio Frontend                         │
 │     React 18 • TypeScript • Tailwind CSS • @xyflow/react • Vite        │
 └───────────────────▲────────────────────────────────┬───────────────────┘
                     │ REST API                       │ WebSocket / HTTP
 ┌───────────────────┴────────────────────────────────▼───────────────────┐
 │                       MetaForge FastAPI Backend                        │
 │           FastAPI • SQLAlchemy • Pydantic v2 • Uvicorn                 │
 ├────────────────────────────────┬───────────────────────────────────────┤
 │  • Remote Repo & 3-Way Merge   │  • Reverse Engineering & Profiling    │
 │  • Role-Based Access (RBAC)    │  • Multi-Dialect Compilers            │
 │  • MCP JSON-RPC 2024-11-05     │  • Gemini AI Metadata Synthesis       │
 └───────────────────┬────────────────────────────────┬───────────────────┘
                     │                                │
 ┌───────────────────▼────────────┐      ┌────────────▼───────────────────┐
 │ SQLite Metadata Control Plane  │      │ Remote Repository & Checkouts  │
 │  (Users, ACL, Models, Audits)  │      │  (workspace_model/remote_repo) │
 └────────────────────────────────┘      └────────────────────────────────┘
```

---

## Directory Structure

```
data_model/
├── backend/
│   ├── app/
│   │   ├── agent/               # Gemini AI service, LLM executor & MCP server
│   │   ├── auth/                # JWT auth, user directory, ACL models & RBAC
│   │   ├── compilers/           # Snowflake, SQL Server, Oracle & dbt generators
│   │   ├── metamodel/           # Canonical metamodel schema, domains & glossary
│   │   ├── reverse_eng/         # DDL parser, complete compare, Excel/CSV parser
│   │   ├── config.py            # Dynamic configuration & environment loader
│   │   ├── db_connector.py      # Multi-zone database connector & profiling engine
│   │   ├── main.py              # FastAPI application entrypoint & REST endpoints
│   │   └── remote_repo.py       # Remote repository, locking & 3-way merge engine
│   └── tests/                   # 37 comprehensive pytest test suites
├── frontend/
│   ├── src/
│   │   ├── components/          # ERD Canvas, toolbars, inspectors & modals
│   │   ├── services/            # Typed API client service
│   │   ├── store/               # Zustand metamodel & collaboration state store
│   │   └── types/               # Metamodel, ACL, and MCP TypeScript definitions
├── workspace_model/
│   ├── canonical_model.json     # Active local workspace model
│   ├── remote_repo/             # Shared remote models
│   └── local_checkouts/         # User local checked-out working copies
├── mcp_server.py                # Standalone MCP CLI server entrypoint
├── docker-compose.yml           # Docker deployment configuration
├── config.sample.json           # Sample JSON configuration template
├── .env.example                 # Sample environment variables template
├── .gitignore                   # Git exclusion rules for secrets, DBs & builds
└── USERGUIDE.md                 # End-to-end user and administrator guide
```

---

## Quick Start

### Prerequisites
- **Python**: 3.10+ (Python 3.12 recommended)
- **Node.js**: v18+ (Node 20 / 22 recommended) with `npm`
- **Git**

### 1. Clone & Set Up Configuration
```bash
git clone <repository-url>
cd data_model

# Copy sample configuration templates (both are gitignored)
cp .env.example .env
cp config.sample.json config.local.json
```

> **Security Note**: Never commit `.env` or `config.local.json` to Git. Both are listed in `.gitignore`. API keys can also be saved individually by each user inside the application UI.

### 2. Backend Setup
```bash
# Create and activate Python virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install backend dependencies
pip install -r backend/requirements.txt pytest   # optional: pypdf for PDF context documents

# Start FastAPI backend (runs on http://127.0.0.1:8000)
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```

### 3. Frontend Setup
```bash
cd frontend

# Install dependencies and start Vite dev server (runs on http://127.0.0.1:5173)
npm install
npm run dev
```

Open your browser to **`http://127.0.0.1:5173`**.

---

## Default Seed Accounts

MetaForge Studio initializes with four enterprise RBAC user accounts:

| User Account | Email | Password | Role | Permissions |
| :--- | :--- | :--- | :--- | :--- |
| **Enterprise Admin** | `admin@metaforge.local` | `password123` | **Admin** | Full system control, User Management, Model ACLs, Force-Release |
| **Principal Architect** | `architect@metaforge.local` | `password123` | **Data Architect** | Physical & logical modeling, Check-in/out, DDL export, Reverse engineering |
| **Data Steward** | `steward@metaforge.local` | `password123` | **Data Steward** | Business definitions, PII classification, glossary & DQ rules |
| **Analytics Consumer** | `viewer@metaforge.local` | `password123` | **Viewer** | View-only inspection of canvas and remote models |

---

## Model Context Protocol (MCP) Setup

MetaForge Studio features an MCP 2024-11-05 server allowing external AI coding assistants to query and mutate your canonical data models.

### Connecting Claude Code / Gemini CLI
Add MetaForge Studio to your assistant's MCP configuration:

```json
{
  "mcpServers": {
    "metaforge-studio": {
      "command": "/path/to/data_model/.venv/bin/python3",
      "args": ["/path/to/data_model/mcp_server.py"]
    }
  }
}
```

Or connect over HTTP via the backend REST endpoint:
- **MCP Config**: `GET http://127.0.0.1:8000/api/mcp/config`
- **MCP Tools**: `GET http://127.0.0.1:8000/api/mcp/tools`
- **JSON-RPC Dispatcher**: `POST http://127.0.0.1:8000/api/mcp/call`

---

## Running Tests

Run the backend unit and integration test suite:
```bash
.venv/bin/pytest backend/tests -v
```

Verify the frontend build and TypeScript types:
```bash
cd frontend && npm run build
```

---

## Documentation

For step-by-step instructions on canvas modeling, reverse engineering live databases, remote repository check-outs, force-releases, and AI metadata pushback, see **[USERGUIDE.md](USERGUIDE.md)**.
