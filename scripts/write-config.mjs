// Vercel build step: writes config.js from environment variables, if they are set.
// If they aren't, the committed config.js is used unchanged.
//
//   SUPABASE_URL       – Project URL, e.g. https://abcdefghijkl.supabase.co
//   SUPABASE_ANON_KEY  – the publishable (sb_publishable_…) or legacy anon (eyJ…) key
//
// The NEXT_PUBLIC_… / SUPABASE_PUBLISHABLE_KEY names created by Vercel's Supabase
// integration are accepted too. Secret / service_role keys are refused, because this
// file is served to every visitor's browser.
import fs from 'node:fs';

const env = process.env;
const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';
const key =
  env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';

function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role;
  } catch {
    return null;
  }
}

if (!url && !key) {
  console.log('write-config: no Supabase environment variables set; using the committed config.js');
  process.exit(0);
}
if (!url || !key) {
  console.error('write-config: set both SUPABASE_URL and SUPABASE_ANON_KEY (or neither)');
  process.exit(1);
}
if (!/^https:\/\/\S+$/.test(url)) {
  console.error('write-config: SUPABASE_URL must be an https URL');
  process.exit(1);
}
if (key.startsWith('sb_secret_') || (key.startsWith('eyJ') && jwtRole(key) !== 'anon')) {
  console.error('write-config: refusing to publish a secret / service_role key. Use the publishable or anon key.');
  process.exit(1);
}

const config = `// Generated at build time by scripts/write-config.mjs from Vercel environment variables.
window.SPLITTER_CONFIG = ${JSON.stringify({ supabaseUrl: url.replace(/\/+$/, ''), supabaseAnonKey: key }, null, 2)};
`;
fs.writeFileSync(new URL('../config.js', import.meta.url), config);
console.log(`write-config: config.js written for ${url}`);
