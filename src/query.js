import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
    createChatModel,
    LLM_PROVIDER,
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
import { createSearchTool, createGraphTool, createDocumentListTool, createCompareDocumentsTool, createPageContentTool, createExtractTablesTool, createCalculatorTool } from './tools.js';
import * as graph from './graph.js';
import { parsePageNumber } from './utils/documentMatcher.js';
import { pageRange } from './utils/pageRange.js';
import { formatScoreRange } from './utils/scoreRange.js';

export const FALLBACK_ANSWER = "I don't have enough information to answer that question.";

function toText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? c?.content ?? ''))).join('');
    }
    if (content && typeof content === 'object') return content.text ?? content.content ?? String(content);
    return String(content ?? '');
}

const ANSWER_SYSTEM_TEXT = `You are a helpful assistant answering questions based on the provided documentation.

Instructions:
- Answer using ONLY the information in the context below and the conversation above.
- If no passage supports any part of the answer, say "I don't have enough information to answer that question."
- If only part of the answer is available, state what is known and what is missing rather than saying you have no information at all.
- Cite the page number(s) supporting each claim using the [Page N] labels from the context (e.g., "According to [Page 5]..."). Cite a page for EVERY factual claim, including names, dates, and figures.
- When multiple documents are present, also cite the source filename for each claim.
- Be concise and clear.
- Use code examples from the context if relevant.
- Do not speculate or add information not present in the context.
- Preserve numbers, dates, and units exactly as written.`;

const answerSystemMessage = LLM_PROVIDER === 'openrouter'
    ? new SystemMessage({ content: [{ type: 'text', text: ANSWER_SYSTEM_TEXT, cache_control: { type: 'ephemeral' } }] })
    : ['system', ANSWER_SYSTEM_TEXT];

const answerPrompt = ChatPromptTemplate.fromMessages([
    answerSystemMessage,
    new MessagesPlaceholder('chat_history'),
    ['human', 'Context from the documentation:\n{context}\n\nQuestion: {question}\n\nAnswer:'],
]);

const rewritePrompt = ChatPromptTemplate.fromMessages([
    ['system',
`Given the conversation and a follow-up question, rewrite the follow-up question
as a standalone question for searching documentation.

Rules:
- Keep the user's original meaning and intent.
- Resolve pronouns and references (it, they, this, that, the above, etc.) using the conversation.
- Preserve document names, named entities, and numeric values exactly.
- If the follow-up is already standalone, return it unchanged.
- If the follow-up introduces a new, unrelated topic, return it unchanged.
- If the follow-up says the answer is in the document or asks for more thoroughness, broaden the search query to cover all relevant aspects.
- Return ONLY the rewritten question, with no explanation.`],
    new MessagesPlaceholder('chat_history'),
    ['human', 'Follow-up question: {question}\nStandalone question:'],
]);

const FOLLOW_UP_PATTERNS = [
    /^(and|also|but|so|then|what about|how about|what else|anything else|why|how so)\b/i,
    /\b(it|its|it's|they|them|their|theirs|this|that|these|those|he|him|his|she|her|hers|former|latter|above|previous|same|such)\b/i,
];
const SHORT_QUESTION_WORDS = 3;

export function needsRewrite(question, chatHistory = []) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return false;

    const text = String(question ?? '').trim();
    if (!text) return false;
    if (isConversational(text)) return false;
    if (FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(text))) return true;

    return text.split(/\s+/).filter(Boolean).length <= SHORT_QUESTION_WORDS;
}

export { formatScoreRange };

function conversationalReply(question) {
    const text = String(question ?? '').trim().toLowerCase();
    if (/^(hi|hello|hey)\b/.test(text)) return "Hello! How can I help you today?";
    if (/^(thanks|thank you|thx|ty|cheers|appreciate)\b/.test(text)) return "You're welcome! Let me know if you have any other questions about the document.";
    if (/^(bye|goodbye)\b/.test(text)) return "Goodbye! Feel free to come back anytime.";
    return "You're welcome! Let me know if you have any other questions about the document.";
}

function isConversational(question) {
    const CONVERSATIONAL_PATTERNS = [
        /^(hi|hello|hey|thanks|thank you|thx|ty|great|awesome|perfect|helpful|got it|ok|okay|sure|bye|goodbye|cool|nice|appreciate|cheers)\b/i,
        /^(that'?s? (it|all|great|helpful|perfect|awesome)|you'?re (welcome|helpful)|no (problem|worries))\b/i,
    ];
    const text = String(question ?? '').trim();
    if (!text) return false;
    if (text.split(/\s+/).filter(Boolean).length <= 4 && CONVERSATIONAL_PATTERNS.some((p) => p.test(text))) {
        return true;
    }
    return false;
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
    maxAgentSteps = (Number.isInteger(Number(process.env.AGENTIC_MAX_STEPS)) && Number(process.env.AGENTIC_MAX_STEPS) >= 1)
        ? Number(process.env.AGENTIC_MAX_STEPS)
        : 5,
    indexName = null,
    documentFilter = null,
    documents = null,
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
        ? createSearchTool(vectorStore, { scoreThreshold, defaultTopK: Math.max(topK, 10), documentFilter, documents: documents || [] })
        : null;
    const agentTools = [];
    if (searchTool) agentTools.push(searchTool);
    agentTools.push(createPageContentTool(vectorStore, { scoreThreshold, documentFilter, documents: documents || [] }));
    agentTools.push(createExtractTablesTool(vectorStore, { documentFilter, documents: documents || [] }));
    agentTools.push(createCalculatorTool());
    if (agentic) {
        agentTools.push(createDocumentListTool(documents || []));
    }
    if (agentic && indexName && graph.getDriver()) {
        agentTools.push(createGraphTool(indexName));
        agentTools.push(createCompareDocumentsTool(indexName));
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
        if (isConversational(question)) {
            const convPrompt = "You are a friendly assistant. Respond naturally and concisely (1-3 sentences). Do not search any documents. If the user asks a factual question about a document, gently point them to ask it directly.";
            const msgs = [new SystemMessage(convPrompt), ...chatHistory, new HumanMessage(question)];
            const result = await withRetry(() => model.invoke(msgs), { label: 'Conversational reply', ...retryOptions });
            const reply = result.ok ? toText(result.value.content) : conversationalReply(question);
            const finalReply = reply.trim() ? reply : conversationalReply(question);
            chatHistory.push(new HumanMessage(question), new AIMessage(finalReply));
            pruneHistory();
            if (streaming) {
                onToken(finalReply);
                onToken('\n');
            } else {
                console.log(`\n${finalReply}\n`);
            }
            return;
        }

        // Detect page-specific questions and pre-fetch that page's content.
        const pageNum = parsePageNumber(question);
        if (pageNum) {
            try {
                const pageTool = createPageContentTool(vectorStore, { scoreThreshold, documentFilter, documents: documents || [] });
                const raw = await pageTool.invoke({ page: pageNum });
                let parsed = {};
                try { parsed = JSON.parse(raw); } catch { parsed = {}; }
                if ((parsed.chunks ?? 0) > 0) {
                    const ctx = parsed.content;
                    const messages = [
                        new SystemMessage('You are a helpful assistant. Answer using only the provided page content. Cite the page number. If the content does not contain the answer, say so.'),
                        ...chatHistory.slice(-6),
                        new HumanMessage(`Context from page ${pageNum}:\n\n${ctx}\n\nQuestion: ${question}`),
                    ];
                    const result = await withRetry(() => model.invoke(messages), { label: 'Answering from page', ...retryOptions });
                    const answer = result.ok ? toText(result.value.content) : FALLBACK_ANSWER;
                    const finalAnswer = answer.trim() ? answer : FALLBACK_ANSWER;
                    chatHistory.push(new HumanMessage(question), new AIMessage(finalAnswer));
                    pruneHistory();
                    if (streaming) {
                        onToken(finalAnswer);
                        onToken('\n');
                    } else {
                        console.log(`\n${finalAnswer}\n`);
                    }
                    return;
                }
            } catch (e) {
                console.warn('Page pre-fetch failed:', e.message);
            }
        }

        const docList = Array.isArray(documents) && documents.length
            ? documents.map((d) => `- ${d.name}${d.documentId ? ` (id: ${d.documentId})` : ''}`).join('\n')
            : '(no documents indexed yet — tell the user to upload a PDF first)';

        const AGENTIC_SYSTEM_PROMPT = `You are a helpful assistant answering questions about the provided documentation.

Available documents:
${docList}

You have tools. Use them to gather evidence before answering. Take your time and search thoroughly before concluding. Follow this workflow:

1. Decide whether tools are needed:
   - Greetings, thanks, or meta/small-talk: answer directly, do not call any tools.
   - Any factual question about the documents: use tools.

2. Plan retrieval (call tools; parallelize independent calls in one step):
   - Simple fact: one search_documents call with a focused, standalone query.
   - Complex or multi-part question: decompose into focused sub-queries and call search_documents for each. For questions with several conditions, clauses, dates, or named parties, issue separate searches for each before answering.
   - Cross-document question: call list_documents first, then search_documents with the "document" param for each relevant document.
   - "What is on page N" / full page text: get_page_content.
   - Tables, slabs, rate cards, thresholds: extract_tables on the relevant page.
   - Any numeric computation (percentages, interest, EMI, fees, limits): calculate. Never compute in your head.
   - Relationships, traversal, aggregation, cross-document links: query_graph (read-only Cypher; always filter by $indexName).
   - Compare documents / shared concepts: compare_documents.

3. Iterate: after tool results, decide if you have enough. If not, refine (e.g., get_page_content for a promising page, or a new search with different phrasing). Do not conclude "not enough information" until you have issued at least 2-3 different search queries with varied phrasing, and if a promising page appears, fetch its full content. Stop once sufficient.

4. Answer:
   - Answer ONLY from retrieved context. If no relevant context was found, say "I don't have enough information to answer that question."
- Do not declare "not enough information" on the first retrieval pass. Only do so after at least 2 retrieval rounds with varied phrasing (and fetching full pages of promising results) have failed to answer any sub-part.
   - Cite page numbers as [Page N] for EVERY factual claim, including names, dates, and figures. When multiple documents are involved, also cite the source filename.
   - Do not fabricate page numbers, facts, or values.
   - For multi-part questions, decompose into sub-queries and retrieve thoroughly across all relevant pages and tables before concluding information is missing.
   - Be concise and clear.

Rules:
- Never call the same tool with the same arguments twice.
- Prefer parallel calls for independent sub-queries.
- Do not call tools for greetings or meta questions.
- Self-check before giving up: verify you searched for each sub-part of the question. If any sub-part is unaddressed, search again before concluding.
- If a search returns chunks but does not fully answer, retry with broader or differently worded queries, or fetch the full page of the most relevant result.
- If a tool returns an error or empty result, try an alternative approach or state the limitation.
- Once you have enough context, stop calling tools and provide the final answer.`;

        const messages = [
            new SystemMessage(
                LLM_PROVIDER === 'openrouter'
                    ? { content: [{ type: 'text', text: AGENTIC_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] }
                    : AGENTIC_SYSTEM_PROMPT
            ),
            ...chatHistory.slice(-6),
            new HumanMessage(question),
        ];

        const isGreeting = /^(hi|hello|hey|thanks|thank you|bye|goodbye|help|ok|okay|sure|yes|no)\b/i.test(question.trim()) && question.trim().split(/\s+/).length <= 4;
        const boundModel = isGreeting ? agentModel : model.bindTools(agentTools, { tool_choice: 'required' });

        let finalAnswer = null;
        let hasContext = false;
        let hasCalculation = false;
        let searched = false;
        let steps = 0;

        while (steps < maxAgentSteps) {
            steps++;
            const modelToUse = (steps === 1 && !isGreeting) ? boundModel : agentModel;
            const result = await withRetry(
                () => modelToUse.invoke(messages),
                { label: `Agent step ${steps}`, ...retryOptions }
            );
            if (!result.ok) {
                throw new Error(`Gemini agent failed: ${result.message}`);
            }

            const ai = result.value;
            messages.push(ai);

            const toolCalls = ai.tool_calls ?? [];
            if (toolCalls.length === 0) {
                const candidate = toText(ai.content);
                const seemsInsufficient = /don't have enough|do not have enough|not enough (information|context)|insufficient (information|context)|could not find|unable to find|unable to answer|cannot answer|cannot fully|not able to (find|answer)|no (relevant|supporting) (information|context|passages)/i.test(candidate);
                // Don't accept a premature "not enough information" answer; force more retrieval.
                if (seemsInsufficient && searched && steps < maxAgentSteps) {
                    console.log('Answer looks insufficient; forcing additional retrieval...');
                    messages.push(new HumanMessage(
                        'Your previous answer concluded information is missing. Do not conclude yet. ' +
                        'Run at least 2 more varied searches with different phrasing, and fetch the full content ' +
                        'of any promising page with get_page_content, then answer. Do not repeat prior queries.'
                    ));
                    continue;
                }
                // Even when no more retrieval steps remain, do not accept an "insufficient"
                // verdict if we already gathered context: finalize from the gathered passages
                // instead of echoing the premature conclusion.
                if (seemsInsufficient && hasContext) {
                    console.log('Answer looks insufficient despite gathered context; finalizing from context...');
                    finalAnswer = null;
                    break;
                }
                finalAnswer = candidate;
                break;
            }

            searched = true;
            console.log(`Step ${steps}: searching ${toolCalls.length} query(s)...`);
            const toolMessages = await Promise.all(toolCalls.map(async (tc) => {
                const t = toolByName[tc.name];
                const args = tc.args ?? {};
                const raw = t ? await t.invoke(args) : JSON.stringify({ error: `Unknown tool ${tc.name}` });
                let parsed = {};
                try { parsed = JSON.parse(raw); } catch { parsed = {}; }
                if (tc.name === 'search_documents' && (parsed.count ?? 0) > 0) hasContext = true;
                if (tc.name === 'get_page_content' && (parsed.chunks ?? 0) > 0) hasContext = true;
                if (tc.name === 'extract_tables' && parsed.hasTables) hasContext = true;
                if (tc.name === 'query_graph' && Array.isArray(parsed.records) && parsed.records.length > 0) hasContext = true;
                if (tc.name === 'calculate' && parsed.result != null) hasCalculation = true;
                if (tc.name === 'search_documents') {
                    console.log(`  search "${args.query}" → ${parsed.count ?? 0} chunks`);
                } else if (tc.name === 'get_page_content') {
                    console.log(`  page ${args.page} → ${parsed.chunks ?? 0} chunks`);
                } else if (tc.name === 'calculate') {
                    console.log(`  calculate "${args.expression}" → ${parsed.result}`);
                } else {
                    console.log(`  ${tc.name} → ${parsed.count ?? parsed.records?.length ?? 'done'}`);
                }
                return new ToolMessage({ tool_call_id: tc.id, content: raw });
            }));
            messages.push(...toolMessages);
        }

        if (finalAnswer === null) {
            // Safety net: if no context was gathered, try the original question directly.
            if (!hasContext) {
                console.log('No context gathered; retrying with the original question...');
                const raw = await searchTool.invoke({ query: question, topK: topK });
                let parsed = {};
                try { parsed = JSON.parse(raw); } catch { parsed = {}; }
                if ((parsed.count ?? 0) > 0) {
                    hasContext = true;
                    messages.push(new HumanMessage(`Retrieved context (fallback search):\n${raw}`));
                }
            }
            for (let attempt = 0; attempt < 2 && (!finalAnswer || !finalAnswer.trim()); attempt++) {
                if (attempt > 0) console.log('Empty response; retrying final answer...');
                const finalizer = model.bindTools([]);
                const finalMessages = [
                    ...messages,
                    new HumanMessage('You have gathered enough context above. Now answer the original question based only on those retrieved passages. Do not call any tools. Cite a page number for every factual claim, including names, dates, and figures. Use calculate for any arithmetic. The context above was judged relevant to the question, so synthesize the best answer you can from it; only say information is missing for specific sub-parts that are truly absent, never a blanket "I don\'t have enough information".'),
                ];
                const last = await withRetry(
                    () => finalizer.invoke(finalMessages),
                    { label: 'Finalizing answer', ...retryOptions }
                );
                if (last.ok) finalAnswer = toText(last.value.content);
            }
            if (!finalAnswer || !finalAnswer.trim()) finalAnswer = FALLBACK_ANSWER;
        }

        if (searched && !hasContext && !hasCalculation && finalAnswer && !finalAnswer.toLowerCase().includes("don't have enough")) {
            finalAnswer = FALLBACK_ANSWER;
        }
        if (!finalAnswer || !finalAnswer.trim()) finalAnswer = FALLBACK_ANSWER;

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

        if (isConversational(question)) {
            const convPrompt = "You are a friendly assistant. Respond naturally and concisely (1-3 sentences). Do not search any documents. If the user asks a factual question about a document, gently point them to ask it directly.";
            const msgs = [new SystemMessage(convPrompt), ...chatHistory, new HumanMessage(question)];
            const result = await withRetry(() => model.invoke(msgs), { label: 'Conversational reply', ...retryOptions });
            const reply = result.ok ? toText(result.value.content) : conversationalReply(question);
            const finalReply = reply.trim() ? reply : conversationalReply(question);
            chatHistory.push(new HumanMessage(question), new AIMessage(finalReply));
            pruneHistory();
            if (streaming) {
                onToken(finalReply);
                onToken('\n');
            } else {
                console.log(`\n${finalReply}\n`);
            }
            return;
        }

        // Detect page-specific questions and pre-fetch that page's content.
        const pageNum = parsePageNumber(question);
        if (pageNum) {
            try {
                const pageTool = createPageContentTool(vectorStore, { scoreThreshold, documentFilter, documents: documents || [] });
                const raw = await pageTool.invoke({ page: pageNum });
                let parsed = {};
                try { parsed = JSON.parse(raw); } catch { parsed = {}; }
                if ((parsed.chunks ?? 0) > 0) {
                    const ctx = parsed.content;
                    console.log(`Using full content of page ${pageNum}.`);
                    const context = ctx;
                    console.log('Generating answer with Gemini...');
                    const payload = { context: `[Page ${pageNum}]\n${context}`, question, chat_history: chatHistory.slice(-6) };
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
                    const answer = answerResult.value || FALLBACK_ANSWER;
                    const finalAnswer = answer.trim() ? answer : FALLBACK_ANSWER;
                    chatHistory.push(new HumanMessage(question), new AIMessage(finalAnswer));
                    pruneHistory();
                    if (streaming) {
                        if (finalAnswer === FALLBACK_ANSWER && !answer.trim()) {
                            onToken(FALLBACK_ANSWER);
                        }
                        onToken('\n');
                    } else {
                        console.log(`\n${finalAnswer}\n`);
                    }
                    return;
                }
            } catch (e) {
                console.warn('Page pre-fetch failed:', e.message);
            }
        }

        const searchQuery = await rewriteQuestion(question);
        if (searchQuery !== question) {
            console.log(`Standalone search query: "${searchQuery}"`);
        }

        const recentHistory = chatHistory.slice(-6);

        console.log(`Embedding the query and searching Pinecone for the top ${topK} matching chunks...`);
        const searchResult = await withRetry(
            () => vectorStore.similaritySearchWithScore(searchQuery, topK, documentFilter || undefined),
            { label: 'Searching Pinecone', ...retryOptions }
        );

        if (!searchResult.ok) {
            throw new Error(`Pinecone search failed: ${searchResult.message}`);
        }

        const results = searchResult.value ?? [];
        const retrievedDocs = results
            .filter(([, score]) => score >= scoreThreshold)
            .map(([doc]) => doc);

        const pages = [...new Set(retrievedDocs.map(pageRange).filter(Boolean))];
        const scoreRange = formatScoreRange(results.map(([, score]) => score));
        console.log(
            `Retrieved ${results.length} chunks; kept ${retrievedDocs.length} above the ${scoreThreshold} relevance threshold` +
            `${scoreRange ? ` (scores ${scoreRange})` : ''}` +
            `${pages.length ? ` (page(s): ${pages.join(', ')})` : ''}`
        );

        if (retrievedDocs.length === 0) {
            console.log(`${FALLBACK_ANSWER}\n`);
            chatHistory.push(new HumanMessage(question), new AIMessage(FALLBACK_ANSWER));
            pruneHistory();
            return;
        }

        const context = retrievedDocs
            .map((doc) => `[Page ${pageRange(doc) ?? 'unknown'}]\n${doc.pageContent}`)
            .join('\n\n---\n\n');

        console.log('Generating answer with Gemini...');
        const payload = { context, question, chat_history: recentHistory };
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

        const answer = answerResult.value || FALLBACK_ANSWER;
        const finalAnswer = answer.trim() ? answer : FALLBACK_ANSWER;
        chatHistory.push(new HumanMessage(question), new AIMessage(finalAnswer));
        pruneHistory();

        if (streaming) {
            if (finalAnswer === FALLBACK_ANSWER && !answer.trim()) {
                onToken(FALLBACK_ANSWER);
            }
            onToken('\n');
        } else {
            console.log(`\n${finalAnswer}\n`);
        }
    }

    return { chatting, chatHistory, rewriteQuestion };
}