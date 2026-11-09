const { createApp } = require('../src/server');
const { ValidationError } = require('../src/agent-enrichment');

const SECRET = 'test-secret-0123456789abcdef';
const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

function fakeAgent(overrides = {}) {
    return {
        isDryRun: true,
        analyzeDomain: jest.fn(async (domain) => {
            if (domain === 'bad') throw new ValidationError('A valid company domain is required (e.g. "acme.com").');
            if (domain === 'boom.com') throw new Error('OpenAI exploded: sk-secret-details');
            return { domain, icpScore: 80 };
        }),
        syncToHubSpot: jest.fn(async () => ({ status: 'dry_run' })),
        ...overrides,
    };
}

let server;
let baseUrl;
let agent;

beforeEach(async () => {
    agent = fakeAgent();
    const app = createApp({ agent, webhookSecret: SECRET, logger: quietLogger });
    await new Promise((resolve) => {
        server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((resolve) => server.close(resolve)));

const post = (body, headers = { 'x-webhook-secret': SECRET }) =>
    fetch(`${baseUrl}/webhook/enrich`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });

test('refuses to start without a strong webhook secret', () => {
    expect(() => createApp({ agent: fakeAgent() })).toThrow(/WEBHOOK_SECRET/);
    expect(() => createApp({ agent: fakeAgent(), webhookSecret: 'short' })).toThrow(/WEBHOOK_SECRET/);
    expect(() => createApp({ agent: fakeAgent(), webhookSecret: 'change_me_to_a_long_random_string' })).toThrow();
});

test('health endpoint reports dry-run state', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(await res.json()).toEqual({ status: 'ok', dryRun: true });
});

test('rejects requests without the secret', async () => {
    const res = await post({ domain: 'acme.com' }, {});
    expect(res.status).toBe(401);
    expect(agent.analyzeDomain).not.toHaveBeenCalled();
});

test('rejects requests with the wrong secret', async () => {
    const res = await post({ domain: 'acme.com' }, { 'x-webhook-secret': 'wrong' });
    expect(res.status).toBe(401);
});

test('accepts the secret as a Bearer token', async () => {
    const res = await post({ domain: 'acme.com' }, { authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
});

test('enriches and syncs on a valid request', async () => {
    const res = await post({ domain: 'acme.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
        success: true,
        enrichment: { domain: 'acme.com', icpScore: 80 },
        sync: { status: 'dry_run' },
    });
});

test('400 when domain is missing or invalid', async () => {
    expect((await post({})).status).toBe(400);
    const res = await post({ domain: 'bad' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/valid company domain/);
});

test('400 on malformed JSON', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
});

test('upstream failures return a generic 502 without leaking details', async () => {
    const res = await post({ domain: 'boom.com' });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).not.toMatch(/sk-secret/);
});
