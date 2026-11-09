/**
 * One-time setup: creates the custom HubSpot company properties this agent writes to.
 * Usage: HUBSPOT_ACCESS_TOKEN=... npm run setup:hubspot
 * Properties that already exist are left unchanged.
 * The private app token needs the crm.schemas.companies.write scope.
 */
const axios = require('axios');
require('dotenv').config();

const PROPERTIES = [
    { name: 'icp_score', label: 'ICP Score', type: 'number', fieldType: 'number' },
    { name: 'fit_tier', label: 'ICP Fit Tier', type: 'string', fieldType: 'text' },
    { name: 'estimated_revenue', label: 'Estimated Revenue Range', type: 'string', fieldType: 'text' },
    { name: 'personalization_hook', label: 'Personalization Hook', type: 'string', fieldType: 'textarea' },
    { name: 'enrichment_reasoning', label: 'ICP Reasoning', type: 'string', fieldType: 'textarea' },
    { name: 'enriched_at', label: 'Enriched At', type: 'datetime', fieldType: 'date' },
];

async function main() {
    const token = process.env.HUBSPOT_ACCESS_TOKEN || process.env.HUBSPOT_API_KEY;
    if (!token || token.startsWith('your_')) {
        console.error('Set HUBSPOT_ACCESS_TOKEN (HubSpot private app token) first.');
        process.exit(1);
    }
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    for (const p of PROPERTIES) {
        try {
            await axios.post(
                'https://api.hubapi.com/crm/v3/properties/companies',
                { ...p, groupName: 'companyinformation', description: 'Written by the AI Lead Enrichment Agent' },
                { headers }
            );
            console.log(`created  ${p.name}`);
        } catch (err) {
            if (err.response && err.response.status === 409) {
                console.log(`exists   ${p.name}`);
            } else {
                const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
                console.error(`FAILED   ${p.name}: ${detail}`);
                process.exitCode = 1;
            }
        }
    }
}

main();
