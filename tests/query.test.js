import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnableLambda } from '@langchain/core/runnables';
import { AIMessage } from '@langchain/core/messages';
import { createChatSession, FALLBACK_ANSWER, needsRewrite, formatScoreRange } from '../src/query.js';

function silenceConsole(t) {
    const originals = {};
    for (const method of ['log', 'warn', 'error']) {
        originals[method] = console[method];
        console[method] = () => {};
    }
    t.after(() => {
        for (const method of ['log', 'warn', 'error']) {
            console[method] = originals[method];
        }
    });
}

function promptText(prompt) {
    if (prompt && typeof prompt.toChatMessages === 'function') {
        return prompt.toChatMessages()
            .map((message) => {
                const c = message.content;
                if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n');
                return String(c);
            })
            .join('\n');
    }
    return String(prompt);
}

function createVectorStore(handler) {
    const calls = [];
    return {
        calls,
        async similaritySearchWithScore(query, topK) {
            calls.push({ query, topK });
            return handler(query, topK, calls.length);
        },
    };
}

function createModel({ rewrite = 'What is the Node.js event loop?', answer = 'Node.js is a JavaScript runtime.' } = {}) {
    const calls = { rewrite: 0, answer: 0 };
    const prompts = { rewrite: [], answer: [] };

    const model = RunnableLambda.from(async (prompt) => {
        const text = promptText(prompt);
        if (text.includes('Standalone question:')) {
            calls.rewrite++;
            prompts.rewrite.push(text);
            return new AIMessage(typeof rewrite === 'function' ? await rewrite(text) : rewrite);
        }

        calls.answer++;
        prompts.answer.push(text);
        return new AIMessage(typeof answer === 'function' ? await answer(text) : answer);
    });

    return { model, calls, prompts };
}

const highScore = (pageContent, page, pageEnd) => [
    { pageContent, metadata: pageEnd ? { page, pageEnd } : { page } },
    0.92,
];
const lowScore = (pageContent) => [{ pageContent, metadata: { page: 99 } }, 0.1];

function createAgentModel(responses) {
    let i = 0;
    const calls = [];
    const invoke = async (msgs) => {
        calls.push(msgs);
        const r = responses[Math.min(i, responses.length - 1)];
        i++;
        return r;
    };
    const model = {
        bindTools() {
            return { invoke };
        },
        invoke,
    };
    return { model, calls };
}

test('agentic mode calls search_documents and answers from its context', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Event loop details.')]);
    const { model, calls } = createAgentModel([
        {
            content: '',
            tool_calls: [{ id: 'c1', name: 'search_documents', args: { query: 'event loop', topK: 5 } }],
        },
        { content: 'The event loop handles async callbacks [Page 1].' },
    ]);
    const session = createChatSession({ vectorStore, model, agentic: true, maxAgentSteps: 3 });

    await session.chatting('What is the event loop?');

    assert.equal(calls.length, 2);
    assert.equal(vectorStore.calls.length, 1);
    assert.equal(vectorStore.calls[0].query, 'event loop');
    assert.equal(session.chatHistory[1].content, 'The event loop handles async callbacks [Page 1].');
});

test('agentic mode can search multiple times before answering', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore((query) => {
        if (query.includes('streams')) return [highScore('Stream details.')];
        return [highScore('Buffer details.')];
    });
    const { model } = createAgentModel([
        {
            content: '',
            tool_calls: [
                { id: 'a', name: 'search_documents', args: { query: 'streams' } },
                { id: 'b', name: 'search_documents', args: { query: 'buffers' } },
            ],
        },
        {
            content: '',
            tool_calls: [{ id: 'c', name: 'search_documents', args: { query: 'streams vs buffers' } }],
        },
        { content: 'Streams and buffers differ [Page 1].' },
    ]);
    const session = createChatSession({ vectorStore, model, agentic: true, maxAgentSteps: 5 });

    await session.chatting('Compare streams and buffers');

    assert.equal(vectorStore.calls.length, 3);
});

test('agentic mode answers directly without searching when no tool is called', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Irrelevant.')]);
    const { model } = createAgentModel([
        { content: 'Hello! How can I help you today?' },
    ]);
    const session = createChatSession({ vectorStore, model, agentic: true });

    await session.chatting('Hi');

    assert.equal(vectorStore.calls.length, 0);
    assert.equal(session.chatHistory[1].content, 'Hello! How can I help you today?');
});

test('agentic mode stops after maxAgentSteps', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    const { model } = createAgentModel([
        { content: '', tool_calls: [{ id: 'x', name: 'search_documents', args: { query: 'q1' } }] },
        { content: '', tool_calls: [{ id: 'y', name: 'search_documents', args: { query: 'q2' } }] },
        { content: '', tool_calls: [{ id: 'z', name: 'search_documents', args: { query: 'q3' } }] },
    ]);
    const session = createChatSession({ vectorStore, model, agentic: true, maxAgentSteps: 2 });

    await session.chatting('Question');

    // 2 search steps + 1 finalizing call
    assert.equal(vectorStore.calls.length, 2);
});

test('agentic mode uses fallback when no context is found', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [lowScore('Irrelevant.')]);
    const { model } = createAgentModel([
        { content: '', tool_calls: [{ id: 'c1', name: 'search_documents', args: { query: 'nothing' } }] },
        { content: 'I found something anyway.' },
    ]);
    const session = createChatSession({ vectorStore, model, agentic: true, scoreThreshold: 0.6 });

    await session.chatting('Unknown topic');

    assert.equal(session.chatHistory[1].content, "I don't have enough information to answer that question.");
});

test('createChatSession validates maxAgentSteps in agentic mode', () => {
    const vectorStore = createVectorStore(() => []);
    const { model } = createModel();
    assert.throws(
        () => createChatSession({ vectorStore, model, agentic: true, maxAgentSteps: 0 }),
        /maxAgentSteps must be a positive integer/
    );
});
test('createChatSession validates its dependencies and options', () => {
    const vectorStore = createVectorStore(() => []);
    const { model } = createModel();
    assert.throws(() => createChatSession({ vectorStore }), /requires a chat model/);
    assert.throws(
        () => createChatSession({ vectorStore, model, scoreThreshold: 2 }),
        /scoreThreshold must be a number between -1 and 1/
    );
    assert.throws(() => createChatSession({ vectorStore, model, topK: 0 }), /topK/);
    assert.throws(
        () => createChatSession({ vectorStore, model, maxHistoryMessages: -1 }),
        /maxHistoryMessages/
    );
    assert.throws(
        () => createChatSession({ vectorStore, model, onToken: 'not-a-function' }),
        /onToken must be a function/
    );
});

test('the first turn searches with the raw question and answers with context', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [
        highScore('Node.js is a runtime.', 3, 5),
        lowScore('Unrelated content'),
    ]);
    const { model, calls, prompts } = createModel();
    const session = createChatSession({ vectorStore, model, scoreThreshold: 0.6 });

    await session.chatting('What is Node.js?');

    assert.equal(vectorStore.calls.length, 1);
    assert.equal(vectorStore.calls[0].query, 'What is Node.js?');
    assert.equal(vectorStore.calls[0].topK, 6);
    assert.equal(calls.rewrite, 0);
    assert.equal(calls.answer, 1);
    assert.match(prompts.answer[0], /\[Page 3-5\]/);
    assert.match(prompts.answer[0], /Cite the page number/);
    assert.match(prompts.answer[0], /Node\.js is a runtime\./);
    assert.doesNotMatch(prompts.answer[0], /Unrelated content/);
    assert.equal(session.chatHistory.length, 2);
    assert.equal(session.chatHistory[0].content, 'What is Node.js?');
    assert.equal(session.chatHistory[1].content, 'Node.js is a JavaScript runtime.');
});

test('rewriteQuestion returns the question unchanged without history', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => []);
    const { model, calls } = createModel();
    const session = createChatSession({ vectorStore, model });

    assert.equal(await session.rewriteQuestion('standalone question'), 'standalone question');
    assert.equal(calls.rewrite, 0);
});

test('needsRewrite only rewrites likely follow-ups', () => {
    const history = [{ role: 'human' }];

    assert.equal(needsRewrite('What is Node.js?', []), false);
    assert.equal(needsRewrite('What is the difference between streams and buffers?', history), false);
    assert.equal(needsRewrite('What about the event loop?', history), true);
    assert.equal(needsRewrite('Why is it slow?', history), true);
    assert.equal(needsRewrite('More details', history), true);
    assert.equal(needsRewrite('   ', history), false);
});

test('standalone questions skip the rewrite call even with history', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    const { model, calls } = createModel();
    const session = createChatSession({ vectorStore, model });

    await session.chatting('What is Node.js?');
    await session.chatting('What is the difference between streams and buffers?');

    assert.equal(calls.rewrite, 0);
    assert.equal(
        vectorStore.calls[1].query,
        'What is the difference between streams and buffers?'
    );
});

test('follow-up turns rewrite the question before searching', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Event loop details.')]);
    const { model, calls } = createModel();
    const session = createChatSession({ vectorStore, model });

    await session.chatting('What is Node.js?');
    await session.chatting('What about the event loop?');

    assert.equal(calls.rewrite, 1);
    assert.equal(vectorStore.calls.length, 2);
    assert.equal(vectorStore.calls[1].query, 'What is the Node.js event loop?');
    assert.equal(session.chatHistory.length, 4);
});

test('a rewrite failure falls back to the original question', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    let rewriteAttempts = 0;
    const { model } = createModel({
        rewrite: () => {
            rewriteAttempts++;
            throw Object.assign(new Error('Invalid API key'), { status: 401 });
        },
    });
    const session = createChatSession({ vectorStore, model });

    await session.chatting('What is Node.js?');
    await session.chatting('What about the event loop?');

    assert.equal(rewriteAttempts, 1);
    assert.equal(vectorStore.calls[1].query, 'What about the event loop?');
    assert.equal(session.chatHistory.length, 4);
});

test('a blank rewrite result falls back to the original question', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    const { model } = createModel({ rewrite: '   ' });
    const session = createChatSession({ vectorStore, model });

    await session.chatting('What is Node.js?');
    await session.chatting('And the event loop?');

    assert.equal(vectorStore.calls[1].query, 'And the event loop?');
});

test('an empty retrieval result returns the fallback answer', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [lowScore('Not relevant')]);
    const { model, calls } = createModel();
    const session = createChatSession({ vectorStore, model, scoreThreshold: 0.6 });

    await session.chatting('What is Node.js?');

    assert.equal(calls.answer, 0);
    assert.equal(session.chatHistory.length, 2);
    assert.equal(session.chatHistory[1].content, FALLBACK_ANSWER);
});

test('a failed search rejects and leaves history untouched', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => {
        throw Object.assign(new Error('Invalid API key'), { status: 401 });
    });
    const { model } = createModel();
    const session = createChatSession({ vectorStore, model });

    await assert.rejects(() => session.chatting('What is Node.js?'), /Pinecone search failed/);
    assert.equal(session.chatHistory.length, 0);
});

test('a failed answer rejects and leaves history untouched', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    const { model } = createModel({
        answer: () => {
            throw Object.assign(new Error('Invalid API key'), { status: 401 });
        },
    });
    const session = createChatSession({ vectorStore, model });

    await assert.rejects(() => session.chatting('What is Node.js?'), /Gemini answer failed/);
    assert.equal(session.chatHistory.length, 0);
});

test('history is pruned to maxHistoryMessages', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    const { model } = createModel({ answer: 'An answer.' });
    const session = createChatSession({ vectorStore, model, maxHistoryMessages: 2 });

    await session.chatting('First question');
    assert.equal(session.chatHistory.length, 2);

    await session.chatting('Second question');
    assert.equal(session.chatHistory.length, 2);
    assert.equal(session.chatHistory[0].content, 'Second question');
    assert.equal(session.chatHistory[1].content, 'An answer.');
});

test('documents without page metadata still produce context', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [
        [{ pageContent: 'No page here.', metadata: {} }, 0.9],
    ]);
    const { model, prompts } = createModel();
    const session = createChatSession({ vectorStore, model });

    await session.chatting('What is Node.js?');

    assert.match(prompts.answer[0], /\[Page unknown\]/);
});

test('streaming answers are emitted token by token', async (t) => {
    silenceConsole(t);
    const vectorStore = createVectorStore(() => [highScore('Details.')]);
    const { model } = createModel({ answer: 'Streamed answer.' });
    const tokens = [];
    const session = createChatSession({
        vectorStore,
        model,
        streaming: true,
        onToken: (token) => tokens.push(token),
    });

    await session.chatting('What is Node.js?');

    assert.equal(tokens.join(''), 'Streamed answer.\n');
    assert.equal(session.chatHistory[1].content, 'Streamed answer.');
});

test('formatScoreRange summarizes finite scores', () => {
    assert.equal(formatScoreRange([0.61, 0.93]), '0.610-0.930');
    assert.equal(formatScoreRange([0.5]), '0.500-0.500');
    assert.equal(formatScoreRange([Number.NaN, 0.4]), '0.400-0.400');
    assert.equal(formatScoreRange([]), null);
});
