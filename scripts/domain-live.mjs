import { discoverCompanyDomain } from '../server/company-domain.mjs';
import { loadEnv } from 'vite';
const result = await discoverCompanyDomain(process.argv[2] || 'Stripe', { env: loadEnv('development', process.cwd(), '') });
console.log(JSON.stringify(result));
if (!result.domain) process.exitCode = 1;
