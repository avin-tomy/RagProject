# Node PDF RAG

A small RAG pipeline that indexes a PDF into Pinecone and answers questions about it with Gemini.

```
Node.pdf -> pdfLoader -> content-aware chunks -> Gemini embeddings -> Pinecone
                                                                         |
question -> Gemini embedding -> Pinecone top-K -> score filter -> Gemini -> answer
```

## Requirements

- Node.js 20 or newer
- A [Gemini API key](https://aistudio.google.com/apikey)
- A [Pinecone API key](https://app.pinecone.io)

## Setup

```bash
npm install
cp .env.example .env
# edit .env and fill in GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_NAME
```

`PINECONE_INDEX_NAME` must be 1–45 characters using lowercase letters, digits, or
hyphens, and must start and end with a letter or digit (for example `node-pdf-rag`).

The Pinecone index is created automatically by `indexing.js` if it does not exist
(3072 dimensions, cosine metric, serverless). Creation uses `aws` / `us-east-1`
by default; set `PINECONE_CLOUD` and `PINECONE_REGION` to use another region.
The first run waits for the index to become ready, which can take ~10–30 seconds.
An existing index is reused only if its dimension and metric match; otherwise it is
deleted and recreated automatically (so changing embedding models just works).

## Usage

The app is a web application. Run the backend and frontend:

```bash
# terminal 1 - backend API
npm run server

# terminal 2 - frontend
cd frontend
npm run dev
```

Then open http://localhost:5173, sign up, upload a PDF, and ask questions in the chat.

Indexing (CLI, for development) requires a PDF path:

```bash
node src/indexing.js path/to/file.pdf
node src/indexing.js path/to/file.pdf --dry-run
```

`--dry-run` loads and chunks the PDF, prints length/page-span statistics, and exits
without reading API keys or touching Pinecone.

```bash
npm test        # syntax checks + behavioral tests (no API keys needed)
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | yes | – | Gemini API key for embeddings and chat |
| `PINECONE_API_KEY` | yes | – | Pinecone API key |
| `PINECONE_INDEX_NAME` | yes | – | Index to create/use (see naming rules above) |
| `PINECONE_CLOUD` | no | `aws` | Serverless cloud for a new index |
| `PINECONE_REGION` | no | `us-east-1` | Serverless region for a new index |
| `LLM_PROVIDER` | no | `gemini` | `gemini` or `openrouter` |
| `OPENROUTER_API_KEY` | if openrouter | – | OpenRouter API key |
| `OPENROUTER_CHAT_MODEL` | no | `google/gemini-2.0-flash-exp:free` | Chat model on OpenRouter |
| `OPENROUTER_EMBEDDING_MODEL` | no | `openai/text-embedding-3-small` | Embedding model on OpenRouter |
| `EMBEDDING_DIMENSION` | no | auto | Override embedding dimension (1536 for OpenAI small) |
| `EXTRACTION_MODEL` | no | chat model | Model used for entity extraction |
| `AGENTIC_RAG` | no | `false` | Enable multi-step agentic RAG |

Blank values are treated as unset. `SCORE_THRESHOLD` must be a number between
`-1` and `1`. Lower it (e.g. `0.5`) if valid questions are being rejected; raise
it (e.g. `0.7`) if irrelevant chunks reach the prompt.

Other tuning constants live in `config.js`: the chat model, `DEFAULT_TOP_K` (10
retrieved chunks), and `DEFAULT_MAX_HISTORY_MESSAGES` (10 messages of memory).
Chunking constants (`CHUNK_SIZE`, `CHUNK_OVERLAP`, `MIN_CHUNK_SIZE`) live in
`chunking.js`.

## How indexing works

- `pdfLoader.js` extracts text page by page using the PDF.js build bundled with
  `pdf-parse`. No PDF loader package is needed.
- `chunking.js` cleans repeated page headers, skips table-of-contents pages, and
  builds chunks that can span page boundaries. Overlap is capped so no chunk
  exceeds `CHUNK_SIZE`, and short document tails are kept rather than dropped.
- Every chunk is embedded **before** the index is modified. If any embedding
  batch fails, nothing is written and the previous index is left intact, so an
  expired key or rate limit cannot destroy a working index.
- Embedding and upserting are separate phases, so a failed upsert retries only
  the write and never re-embeds the batch (avoiding duplicate quota use).
- After embeddings succeed, the dedicated index is cleared and the prepared
  vectors are upserted in batches. An already-empty index is skipped (Pinecone
  returns 404 for a namespace that does not exist yet), so a fresh first run
  no longer fails on the clear step. Deterministic IDs make reruns idempotent, and
  a custom PDF path uses that file's name for IDs and `source` metadata.
- Finally, the index stats are polled for up to 15 seconds to confirm that the
  expected number of vectors is present. A mismatch exits with code 1.
- Failed embed/upsert batches are retried up to 3 times with exponential backoff
  and jitter. Transient errors (rate limits, timeouts, network failures, 5xx)
  are retried; permanent errors (invalid API key, bad request, dimension
  mismatch) fail fast. `Retry-After` headers are honored.

## How querying works

- At startup, `query.js` checks that the index exists and that its dimension and
  metric match the embedding model. A missing index prints
  `Run "npm run index" first.` instead of failing on the first question.
- Follow-up questions are rewritten into standalone search queries using a
  separate temperature-0 model. Clearly standalone questions skip the rewrite
  call, saving an LLM request on every turn.
- If the rewrite fails, the original question is used.
- The query embedding, Pinecone search, rewrite, and Gemini answer calls all use
  the shared retry logic in `retry.js`.
- Answers stream token by token so the terminal does not look frozen. If a stream
  fails after printing part of an answer, it is not retried (which would duplicate
  output); failures before the first token are retried normally.
- The answer prompt asks Gemini to cite the `[Page N]` labels from the context,
  and the query log prints the minimum/maximum retrieved scores so
  `SCORE_THRESHOLD` can be tuned.
- Retrieved chunks below `SCORE_THRESHOLD` are discarded. If none remain, the
  session returns a fallback answer without calling the chat model.
- Set `AGENTIC_RAG=true` to let the model plan and run multiple searches with its own
  sub-queries before answering (useful for complex questions). Default mode uses a
  single retrieval pass.

## Notes

- The index is treated as dedicated to the PDF you index, so reruns replace its
  contents instead of accumulating duplicates. Use a namespace per document if
  you need to keep multiple PDFs in one index.
- `npm run reset -- --yes` empties the configured index and verifies the count is
  zero. It is destructive, so the confirmation flag is required.
- Indexing and querying share the model and client setup in `config.js`, so they
  always agree on the embedding model, dimension, and metric.
- Batch sizes, retry counts, chunk sizes, and polling limits are validated before
  use, so an accidental zero cannot create an infinite loop.
- `@langchain/community` and `readline-sync` were removed. PDF parsing uses the
  bundled PDF.js engine in `pdf-parse`, and the prompt uses Node's built-in
  `node:readline/promises`.

## Tests

`npm test` runs `node --check` on every source file and then the `node:test`
suite in `test/`. The tests cover retry classification/backoff/jitter,
`Retry-After`, chunking edge cases, config validation, batch embedding/upsert
behavior, index verification, reset confirmation, CLI argument parsing, chunk
statistics, and query session behavior (rewrite heuristic, streaming, citations,
fallbacks, history pruning) using fake models and vector stores. They do not make
network calls and do not need API keys.

## Frontend (React)

A React (Vite) frontend lives in `frontend/`. It currently provides **login/signup** and a **PDF upload** screen (drag-and-drop, PDF-only, 10 MB limit) with a per-user list of uploaded files. Auth and uploads are client-side (localStorage) for now; backend wiring comes later.

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # production build
```


```
src/           Backend source (config, retry, chunking, pdfLoader, indexing, query, reset, tools, graph, entityExtractor, server, models, middleware, utils)
tests/         node:test behavioral tests
frontend/      React (Vite) frontend
Pdf/           Source PDFs
uploads/       Uploaded PDFs (gitignored, deleted after indexing)
.env.example   Environment variable template
```
