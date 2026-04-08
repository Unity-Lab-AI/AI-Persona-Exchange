/**
 * Shared Supabase client + hub helpers for all pages (test.html, dashboard.html, docs.html).
 * index.html has its own inline client — this file covers the rest.
 */

var SUPA_URL = 'https://szojggcbtctucvswhzsm.supabase.co';
var SUPA_KEY = 'sb_publishable_htATCFp-Wr3_8tyx85SQFA_IY9jzfh2';
var sb = null;
var useServer = false;
var sseSource = null;

var hub = {
    getPersonas: async function() {
        var res = await sb.from('personas_with_ratings').select('*').order('created_at', { ascending: true });
        var personas = res.data || [];
        return { personas: personas, total: personas.length };
    },
    getAccounts: async function() {
        var res = await sb.from('public_accounts').select('*');
        var accounts = res.data || [];
        return { accounts: accounts, total: accounts.length };
    },
    getComments: async function(personaId) {
        var q = sb.from('comments').select('*').order('created_at', { ascending: false });
        if (personaId) q = q.eq('persona_id', personaId);
        var res = await q;
        return res.data || [];
    },
    postTestDecision: async function(personaId, action) {
        var sessionId = sessionStorage.getItem('chat_session_id') || localStorage.getItem('chat_session_id') || '';
        return sb.rpc('send_chat', {
            p_session_id: sessionId,
            p_sender: 'user',
            p_message: action === 'apply' ? 'Install persona: ' + personaId : 'skip ' + personaId
        });
    }
};

async function hubInit() {
    sb = window.supabase.createClient(SUPA_URL, SUPA_KEY);

    // Try connecting to local SSE server for live events
    try {
        var res = await fetch('http://localhost:3000/health', { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
            useServer = true;
            sseSource = new EventSource('http://localhost:3000/events');
        }
    } catch(e) { /* no local server SSE — Supabase Realtime handles it */ }

    return { supabase: sb, hub: hub };
}
