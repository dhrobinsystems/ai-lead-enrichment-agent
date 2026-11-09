const LeadEnrichmentAgent = require('../src/agent-enrichment');
const {
    normalizeDomain,
    tierFromScore,
    validateAiOutput,
    parseJsonLoose,
    ValidationError,
} = require('../src/agent-enrichment');

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} };

const APOLLO_ORG = {
    organization: {
        name: 'Acme Corp',
        industry: 'computer software',
        estimated_num_employees: 120,
        annual_revenue_printed: '$15M',
        annual_revenue: 15000000,
        short_description: 'Acme builds workflow software for logistics teams.',
        keywords: ['logistics', 'saas'],
        technology_names: ['HubSpot', 'Salesforce'],
        country: 'United States',
        founded_year: 2015,
    },
};

function openAiReply(obj) {
    return { data: { choices: [{ message: { content: JSON.stringify(obj) } }] } };
}

function makeHttp(overrides = {}) {
    return {
        get: jest.fn(async () => ({ data: APOLLO_ORG })),
        post: jest.fn(async (url) => {
            if (url.includes('openai.com')) {
                return openAiReply({ icpScore: 87.6, personalizationHook: 'Hi.  Two sentences.', reasoning: 'Good fit.' });
            }
            if (url.endsWith('/companies/search')) return { data: { total: 0, results: [] } };
            if (url.endsWith('/companies')) return { data: { id: 'new-123' } };
            throw new Error(`unexpected POST ${url}`);
        }),
        patch: jest.fn(async () => ({ data: { id: 'existing-1' } })),
        ...overrides,
    };
}

const liveEnv = {
    OPENAI_API_KEY: 'sk-test',
    APOLLO_API_KEY: 'apollo-test',
    HUBSPOT_ACCESS_TOKEN: 'pat-test',
    AGENT_DRY_RUN: 'false',
};

describe('normalizeDomain', () => {
    test.each([
        ['acme.com', 'acme.com'],
        ['  ACME.COM  ', 'acme.com'],
        ['https://www.acme.com/pricing?x=1', 'acme.com'],
        ['http://sub.acme.co.uk:8080/', 'sub.acme.co.uk'],
        ['jane@acme.io', 'acme.io'],
        ['acme.com.', 'acme.com'],
    ])('%p -> %p', (input, expected) => {
        expect(normalizeDomain(input)).toBe(expected);
    });

    test.each([[''], ['localhost'], ['not a domain'], ['acme..com'], ['-acme.com'], ['acme.com"; DROP'], [null], [42]])(
        'rejects %p',
        (input) => {
            expect(normalizeDomain(input)).toBeNull();
        }
    );
});

describe('scoring helpers', () => {
    test('tierFromScore boundaries', () => {
        expect(tierFromScore(100)).toBe('Tier 1');
        expect(tierFromScore(80)).toBe('Tier 1');
        expect(tierFromScore(79)).toBe('Tier 2');
        expect(tierFromScore(60)).toBe('Tier 2');
        expect(tierFromScore(59)).toBe('Tier 3');
        expect(tierFromScore(40)).toBe('Tier 3');
        expect(tierFromScore(39)).toBe('Disqualified');
        expect(tierFromScore(0)).toBe('Disqualified');
    });

    test('validateAiOutput clamps, rounds, derives tier and trims text', () => {
        expect(validateAiOutput({ icpScore: 150, personalizationHook: ' a \n b ', reasoning: 'r' })).toEqual({
            icpScore: 100,
            fitTier: 'Tier 1',
            personalizationHook: 'a b',
            reasoning: 'r',
        });
        expect(validateAiOutput({ icpScore: '-5' }).icpScore).toBe(0);
        expect(validateAiOutput({ icpScore: 59.6 }).fitTier).toBe('Tier 2');
    });

    test('validateAiOutput rejects missing or non-numeric scores', () => {
        expect(() => validateAiOutput({})).toThrow(/icpScore/);
        expect(() => validateAiOutput({ icpScore: 'high' })).toThrow(/icpScore/);
        expect(() => validateAiOutput(null)).toThrow();
    });

    test('parseJsonLoose handles code fences', () => {
        expect(parseJsonLoose('```json\n{"icpScore": 70}\n```')).toEqual({ icpScore: 70 });
        expect(() => parseJsonLoose('no json here')).toThrow();
    });
});

describe('LeadEnrichmentAgent configuration', () => {
    test('dry-run is ON when AGENT_DRY_RUN is unset', () => {
        expect(new LeadEnrichmentAgent({ env: {}, logger: quietLogger }).isDryRun).toBe(true);
    });

    test('dry-run is ON for any value other than "false"', () => {
        for (const v of ['true', 'TRUE', '1', 'yes', '']) {
            expect(new LeadEnrichmentAgent({ env: { AGENT_DRY_RUN: v }, logger: quietLogger }).isDryRun).toBe(true);
        }
        expect(new LeadEnrichmentAgent({ env: { AGENT_DRY_RUN: 'False ' }, logger: quietLogger }).isDryRun).toBe(false);
    });

    test('rejects unknown LLM providers', () => {
        expect(() => new LeadEnrichmentAgent({ env: { LLM_PROVIDER: 'foo' } })).toThrow(/LLM_PROVIDER/);
    });
});

describe('analyzeDomain', () => {
    test('throws ValidationError for bad input', async () => {
        const agent = new LeadEnrichmentAgent({ env: {}, http: makeHttp(), logger: quietLogger });
        await expect(agent.analyzeDomain('nope')).rejects.toBeInstanceOf(ValidationError);
    });

    test('without an LLM key returns a clearly simulated, unscored result and makes no LLM call', async () => {
        const http = makeHttp();
        const agent = new LeadEnrichmentAgent({ env: { OPENAI_API_KEY: 'your_openai_api_key_here' }, http, logger: quietLogger });
        const result = await agent.analyzeDomain('testcorp.com');
        expect(result).toMatchObject({ domain: 'testcorp.com', simulated: true, fitTier: 'Unscored', icpScore: 0 });
        expect(http.post).not.toHaveBeenCalled();
    });

    test('uses Apollo firmographics for headcount/revenue and the LLM only for scoring', async () => {
        const http = makeHttp();
        const agent = new LeadEnrichmentAgent({ env: liveEnv, http, logger: quietLogger });
        const result = await agent.analyzeDomain('https://www.acme.com');

        expect(http.get).toHaveBeenCalledWith(
            expect.stringContaining('apollo.io'),
            expect.objectContaining({ params: { domain: 'acme.com' }, headers: expect.objectContaining({ 'x-api-key': 'apollo-test' }) })
        );
        const prompt = http.post.mock.calls[0][1].messages[0].content;
        expect(prompt).toContain('Acme builds workflow software');

        expect(result).toMatchObject({
            domain: 'acme.com',
            companyName: 'Acme Corp',
            headcount: 120,
            estimatedRevenue: '$15M',
            icpScore: 88,
            fitTier: 'Tier 1',
            personalizationHook: 'Hi. Two sentences.',
            dataSources: ['apollo', 'openai'],
            simulated: false,
        });
    });

    test('without Apollo, headcount and revenue stay null instead of being guessed', async () => {
        const http = makeHttp();
        const agent = new LeadEnrichmentAgent({ env: { OPENAI_API_KEY: 'sk-test' }, http, logger: quietLogger });
        const result = await agent.analyzeDomain('acme.com');
        expect(http.get).not.toHaveBeenCalled();
        expect(result.headcount).toBeNull();
        expect(result.estimatedRevenue).toBeNull();
        expect(result.dataSources).toEqual(['openai']);
    });

    test('an Apollo failure is tolerated', async () => {
        const http = makeHttp({ get: jest.fn(async () => { throw Object.assign(new Error('x'), { response: { status: 429 } }); }) });
        const agent = new LeadEnrichmentAgent({ env: liveEnv, http, logger: quietLogger });
        const result = await agent.analyzeDomain('acme.com');
        expect(result.headcount).toBeNull();
        expect(result.icpScore).toBe(88);
    });

    test('supports Anthropic as the LLM provider', async () => {
        const http = makeHttp({
            post: jest.fn(async () => ({
                data: { content: [{ type: 'text', text: '{"icpScore": 45, "personalizationHook": "h", "reasoning": "r"}' }] },
            })),
        });
        const agent = new LeadEnrichmentAgent({
            env: { LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-test' },
            http,
            logger: quietLogger,
        });
        const result = await agent.analyzeDomain('acme.com');
        const [url, body, cfg] = http.post.mock.calls[0];
        expect(url).toContain('anthropic.com');
        expect(cfg.headers['x-api-key']).toBe('sk-ant-test');
        expect(body.model).toBe('claude-sonnet-5-5');
        expect(result).toMatchObject({ icpScore: 45, fitTier: 'Tier 3', dataSources: ['anthropic'] });
    });
});

describe('syncToHubSpot', () => {
    async function enrichedWith(env, http) {
        const agent = new LeadEnrichmentAgent({ env, http, logger: quietLogger });
        return { agent, enriched: await agent.analyzeDomain('acme.com') };
    }

    test('dry-run makes no HubSpot calls and returns the payload', async () => {
        const http = makeHttp();
        const { agent, enriched } = await enrichedWith({ ...liveEnv, AGENT_DRY_RUN: 'true' }, http);
        http.post.mockClear();
        const sync = await agent.syncToHubSpot(enriched);
        expect(sync.status).toBe('dry_run');
        expect(sync.properties).toMatchObject({ domain: 'acme.com', icp_score: 88, numberofemployees: 120 });
        expect(http.post).not.toHaveBeenCalled();
        expect(http.patch).not.toHaveBeenCalled();
    });

    test('creates the company when no match exists', async () => {
        const http = makeHttp();
        const { agent, enriched } = await enrichedWith(liveEnv, http);
        const sync = await agent.syncToHubSpot(enriched);
        expect(sync).toEqual({ status: 'success', action: 'created', companyId: 'new-123' });
        const createCall = http.post.mock.calls.find(([url]) => url.endsWith('/crm/v3/objects/companies'));
        expect(createCall[1].properties).toMatchObject({ name: 'Acme Corp', domain: 'acme.com', fit_tier: 'Tier 1' });
        expect(createCall[2].headers.Authorization).toBe('Bearer pat-test');
    });

    test('updates the existing company instead of creating a duplicate', async () => {
        const http = makeHttp();
        http.post.mockImplementation(async (url) => {
            if (url.includes('openai.com')) return openAiReply({ icpScore: 70, personalizationHook: 'h', reasoning: 'r' });
            if (url.endsWith('/companies/search')) return { data: { total: 1, results: [{ id: 'existing-1' }] } };
            throw new Error(`should not POST to ${url}`);
        });
        const { agent, enriched } = await enrichedWith(liveEnv, http);
        const sync = await agent.syncToHubSpot(enriched);
        expect(sync).toEqual({ status: 'success', action: 'updated', companyId: 'existing-1' });
        expect(http.patch).toHaveBeenCalledWith(
            expect.stringContaining('/crm/v3/objects/companies/existing-1'),
            { properties: expect.objectContaining({ icp_score: 70, fit_tier: 'Tier 2' }) },
            expect.any(Object)
        );
        expect(http.patch.mock.calls[0][1].properties.name).toBeUndefined();
    });

    test('never writes simulated results to the CRM', async () => {
        const http = makeHttp();
        const { agent, enriched } = await enrichedWith({ AGENT_DRY_RUN: 'false', HUBSPOT_ACCESS_TOKEN: 'pat' }, http);
        const sync = await agent.syncToHubSpot(enriched);
        expect(sync).toMatchObject({ status: 'skipped', reason: 'simulated_result' });
        expect(http.post).not.toHaveBeenCalled();
    });

    test('fails loudly when live mode has no HubSpot token', async () => {
        const http = makeHttp();
        const { agent, enriched } = await enrichedWith({ OPENAI_API_KEY: 'sk', AGENT_DRY_RUN: 'false' }, http);
        await expect(agent.syncToHubSpot(enriched)).rejects.toThrow(/HUBSPOT_ACCESS_TOKEN/);
    });

    test('omits unknown headcount and revenue rather than writing empty values', async () => {
        const http = makeHttp();
        const { agent, enriched } = await enrichedWith({ OPENAI_API_KEY: 'sk' }, http);
        const props = agent.buildHubSpotProperties(enriched);
        expect(props).not.toHaveProperty('numberofemployees');
        expect(props).not.toHaveProperty('estimated_revenue');
    });
});
