const workflow = require('../workflows/n8n-ai-enrichment-workflow.json');

const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));

/** Runs an n8n Code node's JS with stubbed $json and $('Node').item.json. */
function runCodeNode(name, $json, upstream = {}) {
    const fn = new Function('$json', '$', byName[name].parameters.jsCode);
    const $ = (nodeName) => ({ item: { json: upstream[nodeName] } });
    return fn($json, $)[0].json;
}

describe('n8n workflow structure', () => {
    test('node names are unique and every connection points at a real node', () => {
        expect(new Set(workflow.nodes.map((n) => n.name)).size).toBe(workflow.nodes.length);
        for (const [from, conn] of Object.entries(workflow.connections)) {
            expect(byName[from]).toBeDefined();
            for (const target of conn.main.flat()) expect(byName[target.node]).toBeDefined();
        }
    });

    test('webhook uses header auth and has a Respond node on every path', () => {
        const hook = byName['Webhook Inbound'];
        expect(hook.parameters.authentication).toBe('headerAuth');
        expect(hook.parameters.responseMode).toBe('responseNode');
        const responders = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.respondToWebhook');
        expect(responders.map((n) => n.name).sort()).toEqual(
            ['Respond 400 Invalid Domain', 'Respond Dry Run', 'Respond Success'].sort()
        );
    });

    test('dry-run defaults to true in the workflow', () => {
        expect(byName['Config & Validate'].parameters.jsCode).toMatch(/const DRY_RUN = true;/);
    });

    test('HubSpot nodes use the private app token credential and JSON.stringify bodies', () => {
        for (const name of ['HubSpot Find Company', 'HubSpot Update Company', 'HubSpot Create Company']) {
            expect(byName[name].parameters.nodeCredentialType).toBe('hubspotAppToken');
            expect(byName[name].parameters.jsonBody).toMatch(/^=\{\{ JSON\.stringify\(/);
        }
        expect(byName['OpenAI ICP Evaluation'].parameters.jsonBody).toMatch(/^=\{\{ JSON\.stringify\(/);
    });
});

describe('n8n code nodes', () => {
    test('Config & Validate normalizes and validates the domain', () => {
        expect(runCodeNode('Config & Validate', { body: { domain: 'https://www.Acme.com/x' } })).toMatchObject({
            valid: true,
            domain: 'acme.com',
            dryRun: true,
        });
        expect(runCodeNode('Config & Validate', { body: { domain: 'nope' } }).valid).toBe(false);
        expect(runCodeNode('Config & Validate', { body: {} }).valid).toBe(false);
    });

    const cfg = { valid: true, domain: 'acme.com', dryRun: true, icpDescription: 'B2B SaaS' };

    test('Build Prompt includes Apollo data when present and tolerates its absence', () => {
        const withOrg = runCodeNode(
            'Build Prompt',
            { organization: { name: 'Acme', estimated_num_employees: 50, annual_revenue_printed: '$5M' } },
            { 'Config & Validate': cfg }
        );
        expect(withOrg.firmographics).toMatchObject({ name: 'Acme', headcount: 50, revenueRange: '$5M' });
        expect(withOrg.prompt).toContain('"name": "Acme"');

        const withoutOrg = runCodeNode('Build Prompt', { error: { message: '401' } }, { 'Config & Validate': cfg });
        expect(withoutOrg.firmographics).toBeNull();
        expect(withoutOrg.prompt).toContain('No firmographic data');
    });

    test('Validate AI Output clamps score, derives tier, and uses Apollo figures only', () => {
        const ctx = { ...cfg, firmographics: { name: 'Acme', headcount: 50, revenueRange: '$5M' } };
        const content = JSON.stringify({ icpScore: 101, personalizationHook: 'He said "hi".', reasoning: 'ok', headcount: 9999 });
        const out = runCodeNode('Validate AI Output', { choices: [{ message: { content } }] }, { 'Build Prompt': ctx });
        expect(out).toMatchObject({ icpScore: 100, fitTier: 'Tier 1', headcount: 50, estimatedRevenue: '$5M' });
        expect(out.properties).toMatchObject({ domain: 'acme.com', numberofemployees: 50, personalization_hook: 'He said "hi".' });
        expect(out.createProperties.name).toBe('Acme');
        expect(out.properties.name).toBeUndefined();
        // Quotes in LLM text survive because bodies are built with JSON.stringify
        expect(JSON.parse(JSON.stringify({ properties: out.properties })).properties.personalization_hook).toBe('He said "hi".');
    });

    test('Validate AI Output rejects responses without a score', () => {
        expect(() =>
            runCodeNode('Validate AI Output', { choices: [{ message: { content: '{"reasoning":"x"}' } }] }, { 'Build Prompt': cfg })
        ).toThrow(/icpScore/);
    });
});
