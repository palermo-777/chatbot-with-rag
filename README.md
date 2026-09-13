# chatbot-with-rag

A minimal RAG (Retrieval-Augmented Generation) chat demo on Cloudflare Workers: ask a question, it's embedded and matched against a Vectorize index, the matching chunk's text is pulled from D1, and an LLM answers using that chunk as context. An admin panel lets you upload your own `.md` files to add to the corpus, and manage (list/delete) what's already ingested.

## Stack

- **Hono** — routing (`src/index.ts`)
- **Workers AI** — `@cf/baai/bge-base-en-v1.5` for embeddings, `@cf/qwen/qwen3.8-27b` for generation
- **Vectorize** — vector similarity search
- **D1** — stores each chunk's text, keyed by the same id used in Vectorize
- **Workflows** (`RAGWorkflow`) — durable, per-chunk ingestion: split → insert into D1 → embed → upsert into Vectorize, with each chunk independently retryable
- **`@langchain/textsplitters`** (`RecursiveCharacterTextSplitter`) — splits uploaded markdown into chunks before ingestion

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then set a real ADMIN_TOKEN
npx wrangler d1 migrations apply database --local
npm run dev
```

Open the dev server URL, expand "Authenticate to add files or delete RAG content (admin)", unlock it with your `ADMIN_TOKEN`, upload a `.md` file, then ask a question about its content in the chat above.

If you're running this against your own Cloudflare account rather than an existing one, you'll need your own D1 database and Vectorize index — `wrangler.jsonc`'s `d1_databases[0].database_id` and `vectorize[0].index_name` are tied to a specific account and won't work as-is for a fresh one. Create your own (`wrangler d1 create <name>`, `wrangler vectorize create <name> --dimensions=768 --metric=cosine`) and swap the ids in.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/query?text=...` | none | Embed the question, retrieve the closest chunk, generate an answer using it as context |
| `POST` | `/admin/ingest` | Bearer `ADMIN_TOKEN` | Body is raw markdown text (`Content-Type: text/markdown`). Chunks it and starts a `RAGWorkflow` instance to ingest each chunk |
| `GET` | `/admin/notes` | Bearer `ADMIN_TOKEN` | List all stored chunks |
| `DELETE` | `/admin/notes/:id` | Bearer `ADMIN_TOKEN` | Delete one chunk from both D1 and Vectorize |
| `GET` | `/admin/whoami` | Bearer `ADMIN_TOKEN` | Used by the UI to verify a token before unlocking the admin panel |

## Known limitations

- Chunking uses `RecursiveCharacterTextSplitter`'s default `chunkSize`/`chunkOverlap`, which splits on a fixed character budget rather than on the markdown's own `##` section boundaries — a chunk can end up spanning the tail of one section and the start of the next.
- `/api/query` has no rate limiting or origin restriction — fine for local development, worth adding before leaving a deployed instance running publicly.
- No automated test coverage yet beyond the framework's default scaffold test.
- The admin token gate in the UI is a convenience wrapper, not the actual security boundary — the real enforcement is the `bearerAuth` check on the server; anyone with the token can call the admin endpoints directly regardless of what the UI shows.
