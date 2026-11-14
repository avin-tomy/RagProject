import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
    createChatModel,
    DEFAULT_SCORE_THRESHOLD,
    DEFAULT_TOP_K,
    DEFAULT_MAX_HISTORY_MESSAGES,
} from './config.js';
import {
    withRetry,
    errorMessage,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_RETRY_BASE_DELAY_MS,
} from './retry.js';
import * as graph from './graph.js';
import { createSearchTool, createGraphTool } from './tools.js';

export const FALLBACK_ANSWER = "I don't have enough information to answer that question.";

function toText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? c?.content ?? ''))).join('');
    }
    if (content && typeof content === 'object') return content.text ?? content.content ?? String(content);
    return String(content ?? '');
}

// Questions that refer back to the conversation need a standalone rewrite.
// Clearly standalone questions skip the extra LLM call.
const FOLLOW_UP_PATTERNS = [
    /^(and|also|but|so|then|what about|how about|what else|anything else|why|how so)\b/i,
    /\b(it|its|it's|they|them|their|theirs|this|that|these|those|he|him|his|she|her|hers|former|latter|above|previous|same|such)\b/i,
];
const SHORT_QUESTION_WORDS = 3;

export function needsRewrite(question, chatHistory = []) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return false;

    const text = String(question ?? '').trim();
    if (!text) return false;
    if (FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text))) return true;

    return text.split(/\s+/).filter(Boolean).length <= SHORT_QUESTION_WORDS;
}

export function formatScoreRange(scores) {
    const values = scores.filter((score) => Number.isFinite(score));
    if (values.length === 0) return null;
    return `${Math.min(...values).toFixed(3)}-${Math.max(...values).toFixed(3)}`;
}

const rewritePrompt = ChatPromptTemplate.fromMessages([
    ['system',
`Given the conversation and a follow-up question, rewrite the follow-up question
as a standalone question for searching documentation.

Rules:
- Keep the user's original meaning.
- Resolve pronouns and references using the conversation.
- If the follow-up is already standalone, return it unchanged.
- Return ONLY the rewritten question, with no explanation.`],
    new MessagesPlaceholder('chat_history'),
    ['human', 'Follow-up question: {question}\nStandalone question:'],
]);

const answerPrompt = ChatPromptTemplate.fromMessages([
    ['system',
`You are a helpful assistant answering questions based on the provided documentation.

Instructions:
- Answer the question using ONLY the information in the context below and the conversation above.
- If the answer is not in the context, say "I don't have enough information to answer that question."
- Cite the page number(s) supporting each claim using the [Page N] labels from the context.
- Be concise and clear.
- Use code examples from the context if relevant.`],
    new MessagesPlaceholder('chat_history'),
    ['human', 'Context from the documentation:\n{context}\n\nQuestion: {question}\n\nAnswer:'],
]);

function pageRange(doc) {
    const start = doc.metadata?.page;
    const end = doc.metadata?.pageEnd;

    if (typeof start !== 'number') return null;
    return typeof end === 'number' && end !== start ? `${start}-${end}` : `${start}`;
}

export function createChatSession({
    vectorStore,
    model,
    rewriteModel = model,
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
    topK = DEFAULT_TOP_K,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
    retry = {},
    streaming = false,
    onToken = (token) => process.stdout.write(token),
    agentic = false,
    maxAgentSteps = 5,
    indexName = null,
} = {}) {
    if (!vectorStore || typeof vectorStore.similaritySearchWithScore !== 'function') {
        throw new Error('createChatSession requires a vectorStore');
    }
    if (!model) {
        throw new Error('createChatSession requires a chat model');
    }
    if (!rewriteModel) {
        throw new Error('createChatSession requires a rewrite model');
    }
    if (typeof onToken !== 'function') {
        throw new Error('onToken must be a function');
    }
    if (!Number.isFinite(scoreThreshold) || scoreThreshold < -1 || scoreThreshold > 1) {
        throw new Error('scoreThreshold must be a number between -1 and 1');
    }
    if (!Number.isInteger(topK) || topK < 1) {
        throw new Error('topK must be a positive integer');
    }
    if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages < 0) {
        throw new Error('maxHistoryMessages must be a non-negative integer');
    }
    if (agentic && (!Number.isInteger(maxAgentSteps) || maxAgentSteps < 1)) {
        throw new Error('maxAgentSteps must be a positive integer');
    }

    const retryOptions = {
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        baseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
        ...retry,
    };

    const rewriteChain = rewritePrompt.pipe(rewriteModel).pipe(new StringOutputParser());
    const chain = answerPrompt.pipe(model).pipe(new StringOutputParser());

    const searchTool = agentic
        ? createSearchTool(vectorStore, { scoreThreshold, defaultTopK: topK })
        : null;
    const agentTools = [];
    if (searchTool) agentTools.push(searchTool);
    if (agentic && indexName && graph.getDriver()) {
        agentTools.push(createGraphTool(indexName));
    }
    const toolByName = Object.fromEntries(agentTools.map((t) => [t.name, t]));
    const agentModel = agentic && agentTools.length ? model.bindTools(agentTools) : null;
    const chatHistory = [];

    function pruneHistory() {
        if (chatHistory.length > maxHistoryMessages) {
            chatHistory.splice(0, chatHistory.length - maxHistoryMessages);
        }
    }

    async function agenticChat(question) {
        const AGENTIC_SYSTEM_PROMPT = `You are a helpful assistant answering questions about the provided documentation.

You have a tool called search_documents that retrieves relevant passages from the indexed PDF.
- You MUST call search_documents at least once before answering any question about the document's content. Never answer from memory alone.
- For complex questions, call search_documents multiple times with different, focused sub-queries to gather enough context.
- Break complex questions into smaller, specific search queries.
- Stop searching once you have enough context to answer. Do not keep searching after that.
- Answer only from the retrieved context. Cite page numbers using the [Page N] labels.
- If no relevant context is found after searching, say "I don't have enough information to answer that question."
- For greetings, small talk, or meta questions about the conversation, answer directly without searching.`;

        const messages = [
            new SystemMessage(AGENTIC_SYSTEM_PROMPT),
            ...chatHistory,
            new HumanMessage(question),
        ];

        let finalAnswer = null;
        let hasContext = false;
        let searched = false;
        let steps = 0;

        while (steps < maxAgentSteps) {
            steps++;
            const result = await withRetry(
                () => agentModel.invoke(messages),
                { label: `Agent step ${steps}`, ...retryOptions }
            );
            if (!result.ok) {
                throw new Error(`Gemini agent failed: ${result.message}`);
            }

            const ai = result.value;
            messages.push(ai);

            const toolCalls = ai.tool_calls ?? [];
            if (toolCalls.length === 0) {
                finalAnswer = toText(ai.content);
                break;
            }

            console.log(`Step ${steps}: searching ${toolCalls.length} query(s)...`);
            searched = true;
            const toolMessages = await Promise.all(toolCalls.map(async (tc) => {
                const t = toolByName[tc.name];
                const args = tc.args ?? {};
                const raw = t ? await t.invoke(args) : JSON.stringify({ error: `Unknown tool ${tc.name}` });
                let parsed = {};
                try { parsed = JSON.parse(raw); } catch { parsed = {}; }
                if (tc.name === 'search_documents' && (parsed.count ?? 0) > 0) hasContext = true;
                if (tc.name === 'search_documents') {
                    console.log(`  search "${args.query}" → ${parsed.count ?? 0} chunks`);
                } else {
                    console.log(`  graph query → ${parsed.count ?? 0} records`);
                }
                return new ToolMessage({ tool_call_id: tc.id, content: raw });
            }));
            messages.push(...toolMessages);
        }

        if (finalAnswer === null) {
            console.log('Reached the maximum number of search steps; finalizing answer...');
            const finalizer = model.bindTools([]);
            const finalMessages = [
                ...messages,
                new HumanMessage('You have gathered enough context above. Now answer the original question based only on those retrieved passages. Do not call any tools. Cite page numbers.'),
            ];
            const last = await withRetry(
                () => finalizer.invoke(finalMessages),
                { label: 'Finalizing answer', ...retryOptions }
            );
            if (!last.ok) throw new Error(`Gemini answer failed: ${last.message}`);
            finalAnswer = toText(last.value.content);
        }

        if (searched && !hasContext && finalAnswer && !finalAnswer.toLowerCase().includes("don't have enough")) {
            // The model answered without any supporting context; prefer the fallback.
            finalAnswer = FALLBACK_ANSWER;
        }

        chatHistory.push(new HumanMessage(question), new AIMessage(finalAnswer));
        pruneHistory();

        if (streaming) {
            onToken(finalAnswer);
            onToken('\n');
        } else {
            console.log(`\n${finalAnswer}\n`);
        }
    }

    async function rewriteQuestion(question) {
        if (!needsRewrite(question, chatHistory)) return question;

        console.log('Rewriting follow-up question using conversation history...');
        const result = await withRetry(
            () => rewriteChain.invoke({ chat_history: chatHistory, question }),
            { label: 'Rewriting follow-up question', ...retryOptions }
        );

        if (!result.ok) {
            console.warn(`Could not rewrite follow-up question, using it as-is: ${result.message}`);
            return question;
        }

        const standalone = String(result.value ?? '').trim();
        return standalone || question;
    }

    async function chatting(question) {
        if (agentic) {
            await agenticChat(question);
            return;
        }
        const searchQuery = await rewriteQuestion(question);
        if (searchQuery !== question) {
            console.log(`Standalone search query: "${searchQuery}"`);
        }

        console.log(`Embedding the query and searching Pinecone for the top ${topK} matching chunks...`);
        const searchResult = await withRetry(
            () => vectorStore.similaritySearchWithScore(searchQuery, topK),
            { label: 'Searching Pinecone', ...retryOptions }
        );

        if (!searchResult.ok) {
            throw new Error(`Pinecone search failed: ${searchResult.message}`);
        }

        const results = searchResult.value ?? [];
        const documents = results
            .filter(([, score]) => score >= scoreThreshold)
            .map(([doc]) => doc);

        const pages = [...new Set(documents.map(pageRange).filter(Boolean))];
        const scoreRange = formatScoreRange(results.map(([, score]) => score));
        console.log(
            `Retrieved ${results.length} chunks; kept ${documents.length} above the ${scoreThreshold} relevance threshold` +
            `${scoreRange ? ` (scores ${scoreRange})` : ''}` +
            `${pages.length ? ` (page(s): ${pages.join(', ')})` : ''}`
        );

        if (documents.length === 0) {
            console.log(`${FALLBACK_ANSWER}\n`);
            chatHistory.push(new HumanMessage(question), new AIMessage(FALLBACK_ANSWER));
            pruneHistory();
            return;
        }

        const context = documents
            .map((doc) => `[Page ${pageRange(doc) ?? 'unknown'}]\n${doc.pageContent}`)
            .join('\n\n---\n\n');

        console.log('Generating answer with Gemini...');
        const payload = { context, question, chat_history: chatHistory };
        let answerResult;

        if (streaming) {
            let wroteChunk = false;
            answerResult = await withRetry(async () => {
                wroteChunk = false;
                let answer = '';

                try {
                    const stream = await chain.stream(payload);
                    for await (const chunk of stream) {
                        if (!chunk) continue;
                        wroteChunk = true;
                        answer += chunk;
                        onToken(chunk);
                    }
                } catch (err) {
                    if (wroteChunk) {
                        // Partial output was already printed; retrying would
                        // duplicate it, so surface the error instead.
                        onToken('\n');
                        const wrapped = new Error(errorMessage(err));
                        wrapped.retryable = false;
                        throw wrapped;
                    }
                    throw err;
                }

                return answer;
            }, { label: 'Generating answer', ...retryOptions });
        } else {
            answerResult = await withRetry(
                () => chain.invoke(payload),
                { label: 'Generating answer', ...retryOptions }
            );
        }

        if (!answerResult.ok) {
            throw new Error(`Gemini answer failed: ${answerResult.message}`);
        }

        const answer = answerResult.value;
        chatHistory.push(new HumanMessage(question), new AIMessage(answer));
        pruneHistory();

        if (streaming) {
            onToken('\n');
        } else {
            console.log(`\n${answer}\n`);
        }
    }

    return { chatting, chatHistory, rewriteQuestion };
}

// Module used as a library by the web server. Exports createChatSession, needsRewrite, formatScoreRange.
