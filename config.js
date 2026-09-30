/*
 * Public Supabase settings (Project Settings → API in the Supabase dashboard).
 *
 * The anon / publishable key is meant to be public, so it's fine to commit it.
 * The database only exposes functions that need a group's secret link token, and
 * its tables can't be read with this key. Never put the service_role / secret key here.
 *
 * Leave both empty to run Splitter in local-only mode (data stays in this browser).
 */
window.SPLITTER_CONFIG = {
  supabaseUrl: 'https://ikqlzopfhddygqekgsnu.supabase.co',
  supabaseAnonKey: 'sb_publishable_CS8Un0wclUg7z3UqnOEoBQ_ujIpXTpL',
};
