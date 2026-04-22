import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const supabaseUrl = 'https://xspuwldnemmhjhckczow.supabase.co'
const supabaseKey = 'sb_publishable_4DlzH8M5Li9yGjfqIHm91w_sCTqLlrk'

export const supabase = createClient(supabaseUrl, supabaseKey)