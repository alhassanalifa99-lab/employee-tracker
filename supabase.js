import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

export const supabase = createClient(
    'https://xspuwldnemmhjhckczow.supabase.co',
    'sb_publishable_4DlzH8M5Li9yGjfqIHm91w_sCTqLlrk',
    {
        auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false
        }
    }
)