// Vercel build step: writes config.js from environment variables, if they are set.
// Otherwise the committed config.js is used unchanged.
//
//   SUPABASE_URL       – Project URL, e.g. https://abcdefghijkl.supabase.co
//   SUPABASE_ANON_KEY  – the publishable (sb_publishable_…) or legacy anon (eyJ…) key
//
// Common alternative names (Vercel's Supabase integration, NEXT_PUBLIC_…, VITE_…) work too.
// Secret / service_role keys are refused, because config.js is served to every browser.
import fs from 'node:fs';

const URL_NAMES = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL', 'PUBLIC_SUPABASE_URL'];
const KEY_NAMES = [
  'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_KEY', 'SUPABASE_PUBLIC_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_KEY',
  'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'PUBLIC_SUPABASE_ANON_KEY',
];

const clean = (v) => String(v || '').trim().replace(/^['"]|['"]$/g, '').trim();
const pick = (names) => {
  for (const name of names) if (clean(process.env[name])) return { name, value: clean(process.env[name]) };
  return null;
};

function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role;
  } catch {
    return null;
  }
}

const url = pick(URL_NAMES);
const key = pick(KEY_NAMES);

// Names only (never values), to make misnamed variables easy to spot in the Vercel log.
const seen = Object.keys(process.env).filter((n) => /SUPABASE/i.test(n)).sort();
console.log(`write-config: Supabase-related variables present: ${seen.length ? seen.join(', ') : '(none)'}`);

if (key && (key.value.startsWith('sb_secret_') || (key.value.startsWith('eyJ') && jwtRole(key.value) !== 'anon'))) {
  console.error(`write-config: ${key.name} holds a SECRET / service_role key. Refusing to publish it to the browser.`);
  console.error('write-config: use the publishable (sb_publishable_…) or anon key instead.');
  process.exit(1);
}

if (!url || !key) {
  if (url || key) {
    console.warn(`write-config: WARNING — found ${url ? url.name : key.name} but no ${url ? 'key (e.g. SUPABASE_ANON_KEY)' : 'URL (SUPABASE_URL)'}.`);
    console.warn(`write-config: accepted URL names: ${URL_NAMES.join(', ')}`);
    console.warn(`write-config: accepted key names: ${KEY_NAMES.join(', ')}`);
  }
  console.log('write-config: using the committed config.js');
  process.exit(0);
}

if (!/^https:\/\/\S+$/.test(url.value)) {
  console.warn(`write-config: WARNING — ${url.name} is not an https URL; using the committed config.js`);
  process.exit(0);
}

const config = `// Generated at build time by scripts/write-config.mjs from Vercel environment variables.
window.SPLITTER_CONFIG = ${JSON.stringify({ supabaseUrl: url.value.replace(/\/+$/, ''), supabaseAnonKey: key.value }, null, 2)};
`;
fs.writeFileSync(new URL('../config.js', import.meta.url), config);
console.log(`write-config: config.js written from ${url.name} + ${key.name} (${url.value})`);
