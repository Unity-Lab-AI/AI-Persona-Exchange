/**
 * Chat panel for non-index pages (test.html, dashboard.html, docs.html).
 * index.html has the chat panel inline — this file adds it to other pages.
 */

(function() {
    // Get or create session ID
    var urlParams = new URLSearchParams(window.location.search);
    // Session preservation: URL param > sessionStorage > generate new
    var chatSessionId = urlParams.get('session') || sessionStorage.getItem('chat_session_id');
    if (!chatSessionId) {
        var arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        chatSessionId = 'sess_' + Array.from(arr, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    sessionStorage.setItem('chat_session_id', chatSessionId);

    // Rewrite all internal nav links to carry the session ID
    // So navigating between pages preserves the AI connection
    document.querySelectorAll('.topnav-links a, footer a, .links a').forEach(function(a) {
        var href = a.getAttribute('href');
        if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto')) return;
        // Strip any existing session param and add current one
        var url = new URL(href, window.location.origin + window.location.pathname);
        url.searchParams.set('session', chatSessionId);
        a.setAttribute('href', url.pathname + url.search);
    });

    // Use the sb client from supabase-client.js if available, otherwise create one
    var client = window.sb || (window.supabase ? window.supabase.createClient('https://szojggcbtctucvswhzsm.supabase.co', 'sb_publishable_htATCFp-Wr3_8tyx85SQFA_IY9jzfh2') : null);
    if (!client) return;

    var chatOpen = false;

    // Inject styles
    var s = document.createElement('style');
    s.textContent = '.chat-toggle{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:#e11d89;border:none;color:#fff;font-size:1.4rem;cursor:pointer;z-index:999;box-shadow:0 4px 20px rgba(225,29,137,0.4);display:flex;align-items:center;justify-content:center;transition:all 0.2s}.chat-toggle:hover{transform:scale(1.1)}.chat-panel{position:fixed;bottom:0;right:0;width:400px;height:70vh;max-height:600px;background:#18181b;border:1px solid rgba(255,255,255,0.06);border-radius:12px 12px 0 0;z-index:1000;display:flex;flex-direction:column;transform:translateY(100%);transition:transform 0.3s ease;box-shadow:0 -4px 30px rgba(0,0,0,0.5)}.chat-panel.open{transform:translateY(0)}@media(max-width:500px){.chat-panel{width:100%}}.chat-header{padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center}.chat-header h3{font-family:Inter,sans-serif;font-size:0.9rem;font-weight:600;color:#fafafa;display:flex;align-items:center;gap:8px}.chat-header .cdot{width:8px;height:8px;border-radius:50%;background:#22c55e}.chat-header button{background:none;border:none;color:#71717a;font-size:1.2rem;cursor:pointer}.chat-session{padding:6px 18px;font-size:0.65rem;color:#71717a;border-bottom:1px solid rgba(255,255,255,0.06)}.chat-msgs{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:10px}.chat-msg{max-width:85%;padding:10px 14px;border-radius:10px;font-family:Inter,sans-serif;font-size:0.85rem;line-height:1.5;word-wrap:break-word}.chat-msg.user{align-self:flex-end;background:#e11d89;color:#fff;border-bottom-right-radius:4px}.chat-msg.ai{align-self:flex-start;background:#27272a;color:#a1a1aa;border-bottom-left-radius:4px}.chat-msg .msg-meta{font-size:0.65rem;color:rgba(255,255,255,0.4);margin-top:4px}.chat-msg.ai .msg-meta{color:#71717a}.chat-input-area{padding:12px 18px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px}.chat-input{flex:1;background:#09090b;border:1px solid rgba(255,255,255,0.06);color:#fafafa;padding:10px 14px;border-radius:8px;font-family:Inter,sans-serif;font-size:0.85rem;outline:none}.chat-input:focus{border-color:#e11d89}.chat-input::placeholder{color:#71717a}.chat-send{background:#e11d89;border:none;color:#fff;padding:10px 16px;border-radius:8px;cursor:pointer;font-family:Inter,sans-serif;font-size:0.85rem;font-weight:600}.chat-send:hover{background:#c4176f}.chat-empty{text-align:center;padding:30px 20px;color:#71717a;font-size:0.82rem;font-family:Inter,sans-serif}';
    document.head.appendChild(s);

    function esc(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

    // Build panel HTML
    var wrap = document.createElement('div');
    wrap.innerHTML = '<button class="chat-toggle" id="cpToggle" title="Open/close the AI chat panel">&#x1F4AC;</button>' +
        '<div class="chat-panel" id="cpPanel">' +
        '<div class="chat-header"><h3><span class="cdot"></span> AI Chat</h3><button id="cpClear" title="Clear chat and start fresh session" style="background:none;border:none;color:#71717a;font-size:0.7rem;cursor:pointer;margin-right:8px;">Clear</button><button id="cpClose" title="Close chat panel">&times;</button></div>' +
        '<div class="chat-session">Session: ' + chatSessionId.slice(0, 20) + '...</div>' +
        '<div class="chat-msgs" id="cpMsgs"><div class="chat-empty">Your AI connects here automatically.</div></div>' +
        '<div class="chat-input-area"><input class="chat-input" id="cpInput" placeholder="Message your AI..." title="Type a message for your AI"><button class="chat-send" id="cpSend" title="Send message">Send</button></div>' +
        '</div>';
    document.body.appendChild(wrap);

    var panel = document.getElementById('cpPanel');
    var msgs = document.getElementById('cpMsgs');

    document.getElementById('cpToggle').onclick = function() {
        chatOpen = !chatOpen;
        panel.classList.toggle('open', chatOpen);
    };
    document.getElementById('cpClose').onclick = function() {
        chatOpen = false;
        panel.classList.remove('open');
    };
    document.getElementById('cpClear').onclick = function() {
        // New session ID, reload page
        var arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        var newSession = 'sess_' + Array.from(arr, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        sessionStorage.setItem('chat_session_id', newSession);
        window.location.href = window.location.pathname + '?session=' + newSession;
    };

    function addMsg(m) {
        if (msgs.querySelector('.chat-empty')) msgs.innerHTML = '';
        var el = document.createElement('div');
        el.className = 'chat-msg ' + m.sender;
        var time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var meta = m.sender === 'ai' && m.ai_name ? m.ai_name + ' \u00b7 ' + time : time;
        el.innerHTML = esc(m.message) + '<div class="msg-meta">' + meta + '</div>';
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
    }

    // Load history
    client.from('chat_messages').select('*').eq('session_id', chatSessionId).order('created_at', { ascending: true }).then(function(res) {
        if (res.data && res.data.length > 0) {
            msgs.innerHTML = '';
            res.data.forEach(function(m) { addMsg(m); });
        }
    });

    // Realtime subscription
    client.channel('chat-cp-' + chatSessionId)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: 'session_id=eq.' + chatSessionId }, function(payload) {
            addMsg(payload.new);
        })
        .subscribe();

    // Send
    function sendMsg() {
        var input = document.getElementById('cpInput');
        var msg = input.value.trim();
        if (!msg) return;
        input.value = '';
        client.rpc('send_chat', { p_session_id: chatSessionId, p_sender: 'user', p_message: msg }).then(function() {});
    }

    document.getElementById('cpSend').onclick = sendMsg;
    document.getElementById('cpInput').onkeydown = function(e) { if (e.key === 'Enter') sendMsg(); };
})();
