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
import * as graph from './graph.js';
import { createSearchTool, createGraphTool } from './tools.js';

// Short conversational messages (greetings, thanks, compliments) that should
// never trigger a document search or a rewrite.
const CONVERSATIONAL_PATTERNS = [
    /^(hi|hello|hey|thanks|thank you|thx|ty|great|awesome|perfect|helpful|got it|ok|okay|sure|bye|goodbye|cool|nice|appreciate|cheers)\b/i,
    /^(that'?s? (it|all|great|helpful|perfect|awesome)|you'?re (welcome|helpful)|no (problem|worries))\b/i,
];

export const FALLBACK_ANSWER = "I don't have enough information to answer that question.";

export function conversationalReply(question) {
    const text = String(question ?? '').trim().toLowerCase();
    if (/^(hi|hello|hey)\b/.test(text)) return "Hello! How can I help you today?";
    if (/^(thanks|thank you|thx|ty|cheers|appreciate)\b/.test(text)) return "You're welcome! Let me know if you have any other questions about the document.";
    if (/^(bye|goodbye)\b/.test(text)) return "Goodbye! Feel free to come back anytime.";
    return "You're welcome! Let me know if you have any other questions about the document.";
}

export function isConversational(question) {
    const text = String(question ?? '').trim();
    if (!text) return false;
    // Short messages (≤4 words) that match a conversational pattern.
    if (text.split(/\s+/).filter(Boolean).length <= 4 && CONVERSATIONAL_PATTERNS.some((p) => p.test(text))) {
        return true;
    }
    return false;
}

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
    if (isConversational(text)) return false;
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

const ANSWER_SYSTEM_TEXT = `You are a helpful assistant answering questions based on the provided documentation.

Instructions:
- Answer the question using ONLY the information in the context below and the conversation above.
- If the answer is not in the context, say "I don't have enough information to answer that question."
- Cite the page number(s) supporting each claim using the [Page N] labels from the context (e.g., "According to [Page 5]...").
- Be concise and clear.
- Use code examples from the context if relevant.`;

const answerSystemMessage = LLM_PROVIDER === 'openrouter'
    ? new SystemMessage({ content: [{ type: 'text', text: ANSWER_SYSTEM_TEXT, cache_control: { type: 'ephemeral' } }] })
    : ['system', ANSWER_SYSTEM_TEXT];

const answerPrompt = ChatPromptTemplate.fromMessages([
    answerSystemMessage,
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
    maxAgentSteps = 3,
    indexName = null,
    documentFilter = null,
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
        ? createSearchTool(vectorStore, { scoreThreshold, defaultTopK: topK, documentFilter })
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
        if (isConversational(question)) {
            const convPrompt = "You are a friendly assistant. Respond naturally and concisely to the user's message. Do not search any documents.";
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

        const AGENTIC_SYSTEM_PROMPT = `You are a helpful assistant answering questions about the provided documentation.

You have a tool called search_documents that retrieves relevant passages from the indexed PDF.
- You MUST call search_documents at least once before answering any question about the document's content. Never answer from memory alone.
- For complex questions, call search_documents multiple times with different, focused sub-queries to gather enough context.
- Break complex questions into smaller, specific search queries.
- Once you have retrieved relevant passages, stop searching and provide the final answer. Do not search more than necessary.
- Stop searching once you have enough context to answer. Do not keep searching after that.
- Answer only from the retrieved context. Cite page numbers using the [Page N] labels from the context (e.g., "According to [Page 5]...").
- If no relevant context is found after searching, say "I don't have enough information to answer that question."
- For greetings or meta questions about the conversation (not about the document), answer directly without searching.`;

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
            // Safety net: if no search returned context, try the original question directly.
            if (!hasContext) {
                console.log('No context gathered; retrying with the original question...');
                const raw = await searchTool.invoke({ query: question, topK: topK });
                let parsed = {};
                try { parsed = JSON.parse(raw); } catch { parsed = {}; }
                if ((parsed.count ?? 0) > 0) {
                    hasContext = true;
                    messages.push(new ToolMessage({ tool_call_id: 'fallback', content: raw }));
                }
            }
            if (finalAnswer === null && hasContext) {
                for (let attempt = 0; attempt < 2 && (!finalAnswer || !finalAnswer.trim()); attempt++) {
                    if (attempt > 0) console.log('Empty response; retrying final answer...');
                    const finalizer = model.bindTools([]);
                    const finalMessages = [
                        ...messages,
                        new HumanMessage('You have gathered enough context above. Now answer the original question based only on those retrieved passages. Do not call any tools. Cite page numbers.'),
                    ];
                    const last = await withRetry(
                        () => finalizer.invoke(finalMessages),
                        { label: 'Finalizing answer', ...retryOptions }
                    );
                    if (last.ok) finalAnswer = toText(last.value.content);
                }
            }
            if (!finalAnswer || !finalAnswer.trim()) finalAnswer = FALLBACK_ANSWER;
        }

        if (searched && !hasContext && finalAnswer && !finalAnswer.toLowerCase().includes("don't have enough")) {
            // The model answered without any supporting context; prefer the fallback.
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
            const convPrompt = "You are a friendly assistant. Respond naturally and concisely to the user's message. Do not search any documents.";
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

        let finalAnswer = answerResult.value || '';
        // Retry once if the model returned an empty response.
        if (!finalAnswer.trim() && !streaming) {
            console.log('Empty response; retrying answer...');
            const retryResult = await withRetry(
                () => chain.invoke(payload),
                { label: 'Generating answer (retry)', ...retryOptions }
            );
            if (retryResult.ok && retryResult.value?.trim()) {
                finalAnswer = retryResult.value;
            }
        }
        if (!finalAnswer.trim()) finalAnswer = FALLBACK_ANSWER;

        chatHistory.push(new HumanMessage(question), new AIMessage(finalAnswer));
        pruneHistory();

        if (streaming) {
            if (finalAnswer === FALLBACK_ANSWER && !answerResult.value?.trim()) {
                onToken(FALLBACK_ANSWER);
            }
            onToken('\n');
        } else {
            console.log(`\n${finalAnswer}\n`);
        }
    }

    return { chatting, chatHistory, rewriteQuestion };
}

// Module used as a library by the web server. Exports createChatSession, needsRewrite, formatScoreRange.
