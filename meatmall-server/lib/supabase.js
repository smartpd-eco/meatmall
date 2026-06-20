const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // 서버에서는 service role 사용 (RLS 우회)
  { auth: { persistSession: false } }
);

module.exports = supabase;
