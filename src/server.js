const crypto = require('crypto');
const express = require('express');
require('dotenv').config();
const LeadEnrichmentAgent = require('./agent-enrichment');
const { ValidationError } = require('./agent-enrichment');

/** Constant-time comparison (hashing first makes the lengths equal). */
function secretsMatch(provided, expected) {
    if (typeof provided !== 'string' || provided === '') return false;
    const a = crypto.createHash('sha256').update(provided).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function extractSecret(req) {
    const header = req.get('x-webhook-secret');
    if (header) return header;
    const auth = req.get('authorization') || '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

/**
 * @param {object} options
 * @param {LeadEnrichmentAgent} options.agent
 * @param {string} options.webhookSecret Shared secret callers must send.
 */
function createApp({ agent, webhookSecret, logger = console }) {
    if (!webhookSecret || webhookSecret.length < 16 || webhookSecret.startsWith('change_me')) {
        throw new Error('WEBHOOK_SECRET must be set to a random string of at least 16 characters.');
    }

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '10kb' }));

    app.get('/health', (req, res) => {
        res.json({ status: 'ok', dryRun: agent.isDryRun });
    });

    app.post('/webhook/enrich', async (req, res) => {
        if (!secretsMatch(extractSecret(req), webhookSecret)) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }

        const domain = req.body && req.body.domain;
        if (!domain) {
            return res.status(400).json({ success: false, error: 'Domain parameter is required.' });
        }

        try {
            const enrichment = await agent.analyzeDomain(domain);
            const sync = await agent.syncToHubSpot(enrichment);
            return res.json({ success: true, enrichment, sync });
        } catch (err) {
            if (err instanceof ValidationError) {
                return res.status(400).json({ success: false, error: err.message });
            }
            const upstream = err.response ? ` (upstream ${err.response.status})` : '';
            logger.error(`[Server] Enrichment failed for "${domain}"${upstream}:`, err.message);
            return res.status(502).json({ success: false, error: 'Enrichment failed. See server logs for details.' });
        }
    });

    // Malformed JSON bodies
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') {
            return res.status(400).json({ success: false, error: 'Invalid JSON body.' });
        }
        if (err && err.type === 'entity.too.large') {
            return res.status(413).json({ success: false, error: 'Request body too large.' });
        }
        return next(err);
    });

    return app;
}

module.exports = { createApp, secretsMatch };

if (require.main === module) {
    const agent = new LeadEnrichmentAgent();
    const app = createApp({ agent, webhookSecret: process.env.WEBHOOK_SECRET });
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`AI Lead Enrichment Agent running on port ${PORT} (dry-run: ${agent.isDryRun ? 'ON' : 'OFF'})`);
    });
}
