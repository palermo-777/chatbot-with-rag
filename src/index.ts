/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
const RELEVANCE_THRESHOLD:number = 0.58;
const TOP_K:number = 3;

import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { bearerAuth } from 'hono/bearer-auth';
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HTTPException } from 'hono/http-exception';

type AppEnv = { Bindings: Env };

interface RagWorkflowParams {
	data: string;
}

export function filterRelevant(matches: VectorizeMatch[], threshold = RELEVANCE_THRESHOLD) {
	const matchesFiltered:VectorizeMatch[] = matches.filter( (match) => (match.score > threshold)
	);
	return matchesFiltered;
}

	async function QueryVector(question: string, c: Context<AppEnv>) {
	const modelResp = await c.env.AI.run(
		"@cf/baai/bge-base-en-v1.5",
		{
			text: question,
		},
	);

	if (!('data' in modelResp) || !modelResp.data) {
		throw new Error('Embedding model returned an async/queued response, not inline data');
	}
	const vector = modelResp.data[0];

	let { matches } = await c.env.VECTORIZE.query(vector, { topK: TOP_K }); // topK=3 by default
	let notes: string[] = [];
	let citeIds: number[] = []; // id of chunks used in LLM answer

	matches = filterRelevant(matches);
	for (const match of matches) {
		try {
			const { results } = await c.env.database.prepare(
				"SELECT text, id FROM notes WHERE id=?",
			)
				.bind(match.id)
				.run();

			if (results[0] && typeof results[0].text === 'string') {
				notes.push(results[0].text);
				citeIds.push(Number(results[0].id));
			}
			else {
				console.log("No matching vector found or vectorQuery.matches is empty");
			}

		} catch (e) {
			throw new Error("Failed to get data from D1 DB");
		}
	};

	const contextMessage = notes.length
		? `Context:\n${notes.map((note) => `- ${note}`).join("\n")}`
		: "";

	return { contextMessage, citeIds };

}

async function LlmWithRag(c: Context<AppEnv>, question: string, contextMessage:string) {

	let systemPrompt = contextMessage.length > 0
		? `You are a helpful assistant. Answer using the context provided.\n\n${contextMessage}`
		: 'You are a helpful assistant. No relevant notes were found for this question — say so plainly rather than guessing.';

  console.log(`systemPrompt: ${systemPrompt}`)
	const modelResp = await c.env.AI.run("@cf/qwen/qwen3.8-27b", {
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: question }
		]
	}
	);

	const content = modelResp.choices[0]?.message?.content;
	console.log(`LLM answer:\n${content}`);
	if (!content) {
		throw new Error('LLM did not return a text response');
	}


	return content;

}

export class RAGWorkflow extends WorkflowEntrypoint<Env, RagWorkflowParams> {
	async run(event:WorkflowEvent<RagWorkflowParams>, step:WorkflowStep) {

		const { data } = event.payload;
		const env: Env = this.env;

		if (typeof data !== 'string' || !data.trim()) {
			throw new Error('RAGWorkflow requires a non-empty markdown string in its params');
		}

		const texts = await step.do('split text', async() => {
			const splitter = new RecursiveCharacterTextSplitter();
			const output = await splitter.createDocuments([data]);
			return output.map((doc) => doc.pageContent);
		})

		for (const [i, text] of texts.entries()) {
			const record = await step.do(`store in D1 db: ${i}/${texts.length}`, async () => {
				const { results } = await env.database.prepare('INSERT INTO notes (text) VALUES (?) RETURNING *').bind(text).run();
				if (!results[0]) throw new Error(`Failed to insert text #${i} in D1 DB`);
				return Number(results[0].id);
			});

			const vector = await step.do(`Generate Embeddings: ${i}/${texts.length}`, async () => {
				const modelResp = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text });
				if (!('data' in modelResp) || !modelResp.data) {
					throw new Error(`Embedding model returned an async/queued response for ${i}/${texts.length}`);
				}
				const vector = modelResp.data[0];
				if (!vector) throw new Error(`Failed to generate vector embedding for ${i}/${texts.length}`);
				return vector;
			});

			await step.do(`Insert Vector: ${i}/${texts.length}`, async () => {
				return env.VECTORIZE.upsert([{ id: record.toString(), values: vector }]);
			});
		}

	}
}

const app = new Hono<AppEnv>();

app.get("/api/query", async (c) => {
	const question = c.req.query("text");
	if (!question) {
		return c.text("specify text in ?text query", 400)
	}

	const { contextMessage, citeIds } = await QueryVector(question, c);
	const answer = await LlmWithRag(c, question, contextMessage);

	return c.json({ llmAnswer: answer, citedNoteIds: citeIds }, 200);

})

app.post("/admin/ingest",
	bearerAuth<AppEnv>({
		verifyToken: (token, c) => token === c.env.ADMIN_TOKEN,
	}),
	async (c) => {
		const data = await c.req.text();
		if (!data.trim()) {
			return c.json({ error: 'Request body must contain markdown text' }, 400);
		}

		await c.env.RAG_WORKFLOW.create({ params: { data: data } });

		return c.json({message:"Ingestion started"},201);
});

app.get("/admin/whoami",
	bearerAuth<AppEnv>({
		verifyToken: (token, c) => token === c.env.ADMIN_TOKEN,
	}), async (c) => {
		return c.json({ok:"true"});
	});

app.delete("/admin/notes/:id",
	bearerAuth<AppEnv>({
		verifyToken: (token, c) => token === c.env.ADMIN_TOKEN,
	}), async (c) => {
	const { id } = c.req.param();

	const query = `DELETE FROM notes WHERE id = ?`;
	await c.env.database.prepare(query).bind(id).run();

	await c.env.VECTORIZE.deleteByIds([id]);

	return c.body(null, 204);
});

app.get("/admin/notes",
	bearerAuth<AppEnv>({
		verifyToken: (token, c) => token === c.env.ADMIN_TOKEN,
	}), async (c) => {

	const query = `SELECT * FROM notes`;
	let { results } = await c.env.database.prepare(query).run();

	return c.json(results);

	});

app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return err.getResponse();
	}
	console.error(err, err.cause);
	return c.json({ error: err.message }, 500);
});

export default app;
