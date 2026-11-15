# Node PDF RAG

A full-stack RAG (Retrieval-Augmented Generation) web application that lets users upload PDFs (bank circulars, SOPs, manuals), index them into Pinecone, and ask questions with cited answers. Includes agentic multi-step retrieval, knowledge graph (Neo4j), multi-document filtering, and a React frontend.

```
PDF -> pdfLoader -> content-aware chunks -> Gemini/OpenRouter embeddings -> Pinecone
                                                                          |
question -> embedding -> Pinecone top-K (filtered by doc) -> score filter -> LLM -> cited answer
                                                                          |
                                                                    Neo4j graph (entities/relations)
```

## Requirements

- Node.js 20 or newer
- A [Gemini API key](https://aistudio.google.com/apikey) **or** an [OpenRouter API key](https://openrouter.ai/keys)
- A [Pinecone API key](https://app.pinecone.io)
- A [MongoDB Atlas](https://www.mongodb.com/atlas) connection string
- (Optional) A [Neo4j Aura](https://neo4j.com/cloud/aura/) instance for graph RAG

## Setup

```bash
npm install
cd frontend && npm install && cd ..
cp .env.example .env
# edit .env and fill in your keys
```

### Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | if gemini | – | Gemini API key (embeddings + chat) |
| `PINECONE_API_KEY` | yes | – | Pinecone API key |
| `MONGODB_URI` | yes | – | MongoDB Atlas connection string |
| `JWT_SECRET` | yes | – | JWT signing secret (≥32 chars) |
| `LLM_PROVIDER` | no | `gemini` | `gemini` or `openrouter` |
| `OPENROUTER_API_KEY` | if openrouter | – | OpenRouter API key |
| `OPENROUTER_CHAT_MODEL` | no | `inclusionai/ling-3.0-flash` | Chat model on OpenRouter |
| `OPENROUTER_EMBEDDING_MODEL` | no | `perplexity/pplx-embed-v1-0.6b` | Embedding model on OpenRouter |
| `EMBEDDING_DIMENSION` | no | auto | Override (1024 for Perplexity, 3072 for Gemini) |
| `EXTRACTION_MODEL` | no | chat model | Model for entity extraction |
| `NEO4J_URI` | no | – | Neo4j Aura connection URI |
| `NEO4J_USERNAME` | no | – | Neo4j username |
| `NEO4J_PASSWORD` | no | – | Neo4j password |
| `GRAPH_RAG` | no | `false` | Enable graph building during indexing |
| `AGENTIC_RAG` | no | `false` | Enable multi-step agentic retrieval |
| `SCORE_THRESHOLD` | no | 0.5 (gemini) / 0.1 (openrouter) | Min cosine similarity for a chunk |
| `TOP_K` | no | 4 | Chunks retrieved per search |
| `PINECONE_CLOUD` | no | `aws` | Serverless cloud for new index |
| `PINECONE_REGION` | no | `us-east-1` | Serverless region for new index |
| `CORS_ORIGINS` | no | (all) | Comma-separated allowed origins |

Blank values are treated as unset. `SCORE_THRESHOLD` must be a number between `-1` and `1`.

## Running locally

```bash
# Terminal 1 — backend
npm run server

# Terminal 2 — frontend
cd frontend && npm run dev
```

Open http://localhost:5173 → sign up → upload a PDF → ask questions.

## Running tests

```bash
npm test            # syntax checks + 94 behavioral tests (no API keys needed)
npm run test:syntax # syntax checks only
```

## How indexing works

- `pdfLoader.js` extracts text page by page using PDF.js (bundled with `pdf-parse`).
- `chunking.js` cleans repeated headers, skips TOC pages, builds cross-page chunks.
- Each chunk is embedded **before** the index is modified (safe against failures).
- Embedding and upserting are separate phases (failed upserts don't re-embed).
- Per-document vectors: each upload tags chunks with `documentId` and upserts (no full index clear), so multiple PDFs coexist.
- Stale vectors for the same document are removed before re-indexing.
- Index stats are polled to verify the expected vector count.
- Failed batches are retried with exponential backoff + jitter; `Retry-After` headers honored.
- If `GRAPH_RAG=true` and Neo4j is configured, entities and relations are extracted via LLM and stored in Neo4j (batched, parallel, ~3x faster than sequential).
- The original PDF is deleted from disk after indexing (vectors + graph persist externally).

## How querying works

- At startup, the backend verifies the Pinecone index exists and is compatible.
- **Classic mode** (default): rewrite follow-up → embed query → Pinecone top-K → score filter → generate answer.
- **Agentic mode** (`AGENTIC_RAG=true`): the LLM plans and runs multiple searches with its own sub-queries, can use graph queries, tables, calculator, and page fetcher tools.
- **Document filtering**: select specific PDFs in the UI (or mention a document name in your question) to restrict search.
- **Page-specific questions** ("what's on page 5?") pre-fetch the full page content.
- Retrieved chunks below `SCORE_THRESHOLD` are discarded; if none remain, a fallback answer is returned.
- Conversation memory is kept in-memory (last 10 messages) and pruned.
- Greetings/compliments are answered by the LLM directly (no DB search).

## LLM tools (agentic mode)

| Tool | Purpose |
|---|---|
| `search_documents` | Vector search (Pinecone) with optional document filter |
| `get_page_content` | Fetch full text of a specific page |
| `extract_tables` | Extract tabular data from a page |
| `calculate` | Safe math evaluation |
| `query_graph` | Cypher queries on Neo4j (relationships, traversal) |
| `list_documents` | List all indexed documents |
| `compare_documents` | Find shared entities across documents |

## Frontend (React)

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # production build
```

Features: login/signup, PDF upload (drag-and-drop, 25 MB, PDF only), per-PDF indexing progress (Vector DB + Graph DB bars), document filter pills, chat with markdown rendering + citations, "Build Graph" on-demand, remove (cleans vectors + graph), clear chat, export as PDF.

## Deployment (Railway)

```bash
npm run build    # builds frontend
npm start        # starts backend (serves frontend + API)
```

Set all env vars in Railway dashboard. The `railway.json` handles build/deploy. The backend serves the frontend from `frontend/dist`.

## Files

```
src/           Backend source
  config.js     Env validation, models, constants, compatibility checks
  retry.js      Shared retry/backoff helpers
  chunking.js   Cross-page, content-aware chunking
  pdfLoader.js  Page-by-page PDF text extraction
  indexing.js   Build the index (multi-doc, graph, progress)
  query.js      Chat session (classic + agentic, tools, citations)
  reset.js      Delete all vectors from an index
  tools.js      Agent tools (search, page, tables, calc, graph, compare)
  graph.js      Neo4j Aura client + graph helpers
  graphBuilder.js  Knowledge graph construction
  entityExtractor.js  LLM entity/relation extraction
  server.js     Express API + frontend serving
  models/       Mongoose models (User, Pdf)
  middleware/   Auth middleware
  utils/        Helpers (index name, document matcher)
tests/         node:test behavioral tests (94 tests)
frontend/      React (Vite) frontend
uploads/       Uploaded PDFs (gitignored, deleted after indexing)
.env.example   Environment variable template
```
EOF
echo written