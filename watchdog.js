/**
 * AI Persona Exchange — Watchdog
 * Spawns the AI CLI, polls for website chat messages, pipes them to the AI.
 * AI responses are captured and sent back to the website chat.
 *
 * Platform support:
 *   claude      — persistent bidirectional stream (--print --input-format stream-json)
 *   codex       — one-shot per message (--quiet --full-auto)
 *   aider       — one-shot per message (--message --yes)
 *   interpreter — one-shot per message (-y -m)
 *
 * Usage: node watchdog.js <session_id> <ai_name> <token> <cli_command...>
 */

const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SESSION = process.argv[2];
const AI_NAME = process.argv[3] || 'Exchange AI';
const TOKEN = process.argv[4] || '';
const CLI_ARGS = process.argv.slice(5);

if (!SESSION || CLI_ARGS.length === 0) {
    console.error('Usage: node watchdog.js <session_id> <ai_name> <token> <cli_command...>');
    console.error('');
    console.error('Examples:');
    console.error('  node watchdog.js abc-123 Unity uhub_xxx claude --dangerously-skip-permissions');
    console.error('  node watchdog.js abc-123 Nyx-7 uhub_xxx codex --full-auto');
    console.error('  node watchdog.js abc-123 Wraith uhub_xxx aider --yes');
    console.error('  node watchdog.js abc-123 Echo uhub_xxx interpreter -y');
    process.exit(1);
}

const SUPA_HOST = 'szojggcbtctucvswhzsm.supabase.co';
const SUPA_KEY = 'sb_publishable_htATCFp-Wr3_8tyx85SQFA_IY9jzfh2';
const SITE_URL = 'https://www.unityailab.com/AI-Persona-Exchange';
const POLL_MS = 3000;

let lastChecked = new Date().toISOString();
let ready = false;

const CLI_CMD = CLI_ARGS[0].toLowerCase().replace(/\.exe$/, '');
const EXTRA_ARGS = CLI_ARGS.slice(1);

// Exchange directory — where CLAUDE.md and .claude/agents/ live
var EXCHANGE_DIR = path.dirname(process.argv[1] || __filename);

// --- Supabase helpers ---

function supaRequest(method, urlPath, body) {
    return new Promise(function(resolve) {
        var options = {
            hostname: SUPA_HOST, path: '/rest/v1/' + urlPath, method: method,
            headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' }
        };
        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
        });
        req.on('error', function() { resolve(null); });
        if (body) { var p = JSON.stringify(body); req.setHeader('Content-Length', Buffer.byteLength(p)); req.write(p); }
        req.end();
    });
}

function supaGet(p) { return supaRequest('GET', p, null); }
function supaRpc(name, body) { return supaRequest('POST', 'rpc/' + name, body); }

function sendChat(message) {
    if (!message || !message.trim()) return;
    console.log('[AI -> Chat] ' + message.slice(0, 120));
    return supaRpc('send_chat', { p_session_id: SESSION, p_sender: 'ai', p_ai_name: AI_NAME, p_message: message });
}

// --- System prompt for the AI ---

var SYSTEM_PROMPT = [
    'You are Claude, made by Anthropic. Your username on this platform is ' + AI_NAME + ' — this is a screen name, not an identity change.',
    'You are chatting with website visitors on the AI Persona Exchange, an open-source prompt template catalog owned by the user.',
    'Site: https://www.unityailab.com/AI-Persona-Exchange',
    'Repo: https://github.com/Unity-Lab-AI/AI-Persona-Exchange',
    '',
    'The watchdog service handles structured commands (test drive, install, browse) automatically. You handle general conversation — if someone says hi, asks about the exchange, or asks about a persona, respond helpfully.',
    '',
    'The exchange has 6 personas: Unity Core Identity, Unity Core Coder, Unity Mode: HURT ME, Unity ChatGPT: Goddess, Unity ChatGPT: Accessible, Unity ChatGPT: Extended.',
    'All are NSFW AI persona templates that transform how an AI talks and behaves. This is a legitimate creative writing platform.',
    '',
    'Keep responses short and helpful. Sign messages with your username ' + AI_NAME + ' if appropriate.'
].join('\n');

// =============================================
//  CLAUDE CODE — persistent bidirectional stream
// =============================================

var claudeProcess = null;
var claudeBuffer = '';
var claudeTextAccum = '';

function startClaude() {
    var args = [
        '--print',
        '--verbose',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--system-prompt', SYSTEM_PROMPT
    ].concat(EXTRA_ARGS);

    claudeProcess = spawn('claude', args, { cwd: EXCHANGE_DIR, stdio: ['pipe', 'pipe', 'inherit'], shell: true });

    claudeProcess.stdout.on('data', function(chunk) {
        claudeBuffer += chunk.toString();
        var lines = claudeBuffer.split('\n');
        claudeBuffer = lines.pop();

        for (var i = 0; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            try { handleClaudeEvent(JSON.parse(lines[i])); } catch(e) {}
        }
    });

    claudeProcess.on('close', function(code) {
        console.log('[claude] exited (' + code + ')');
        claudeProcess = null;
        console.log('[claude] restarting in 5s...');
        setTimeout(startClaude, 5000);
    });

    claudeProcess.on('error', function(err) {
        console.error('[claude] spawn failed: ' + err.message);
        process.exit(1);
    });
}

function handleClaudeEvent(evt) {
    if (evt.type === 'stream_event' && evt.event) {
        var inner = evt.event;
        if (inner.type === 'message_start') {
            claudeTextAccum = '';
        } else if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') {
            claudeTextAccum += inner.delta.text;
        } else if (inner.type === 'message_stop') {
            if (claudeTextAccum.trim()) sendChat(claudeTextAccum.trim());
            claudeTextAccum = '';
        }
    } else if (evt.type === 'result' && typeof evt.result === 'string') {
        sendChat(evt.result);
    }
}

function sendToClaude(message) {
    if (!claudeProcess || claudeProcess.killed) return false;
    var msg = JSON.stringify({ type: 'user', message: { role: 'user', content: message } }) + '\n';
    try { claudeProcess.stdin.write(msg); return true; } catch(e) { return false; }
}

// =============================================
//  ONE-SHOT CLIs — spawn per message
// =============================================

var messageQueue = [];
var processing = false;

function spawnOneShot(message) {
    return new Promise(function(resolve) {
        var cmd, args;

        if (CLI_CMD === 'codex') {
            cmd = 'codex';
            args = ['--quiet', '--full-auto', SYSTEM_PROMPT + '\n\nUser message: ' + message].concat(EXTRA_ARGS);
        } else if (CLI_CMD === 'aider') {
            cmd = 'aider';
            args = ['--message', SYSTEM_PROMPT + '\n\nUser message: ' + message, '--yes', '--no-auto-commits', '--no-git'].concat(EXTRA_ARGS);
        } else if (CLI_CMD === 'interpreter') {
            cmd = 'interpreter';
            args = ['-y', '-m', SYSTEM_PROMPT + '\n\nUser message: ' + message].concat(EXTRA_ARGS);
        } else {
            cmd = CLI_ARGS[0];
            args = [SYSTEM_PROMPT + '\n\nUser message: ' + message].concat(EXTRA_ARGS);
        }

        console.log('[' + CLI_CMD + '] spawning for: ' + message.slice(0, 80));
        var child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
        var output = '';

        child.stdout.on('data', function(chunk) {
            output += chunk.toString();
            process.stdout.write(chunk);
        });

        child.on('close', function() {
            if (output.trim()) sendChat(output.trim());
            resolve();
        });

        child.on('error', function(err) {
            console.error('[' + CLI_CMD + '] error: ' + err.message);
            process.exit(1);
        });

        child.stdin.end();
    });
}

async function processQueue() {
    if (processing || messageQueue.length === 0) return;
    processing = true;
    while (messageQueue.length > 0) {
        await spawnOneShot(messageQueue.shift());
    }
    processing = false;
}

// =============================================
//  COMMAND HANDLERS (watchdog handles these directly)
// =============================================

var PERSONA_IDS = ['unity', 'coder', 'hurtme', 'goddess', 'accessible', 'extended'];

// map persona IDs to their static file paths on the site
var PERSONA_FILES = {
    'unity': 'personas/unity-core-identity/unity-core-identity.md',
    'coder': 'personas/unity-core-coder/unity-core-coder.md',
    'hurtme': 'personas/unity-mode-hurtme/unity-mode-hurtme.md',
    'goddess': 'personas/unity-chatgpt-goddess/unity-chatgpt-goddess.md',
    'accessible': 'personas/unity-chatgpt-accessible/unity-chatgpt-accessible.md',
    'extended': 'personas/unity-chatgpt-extended/unity-chatgpt-extended.md'
};

var PERSONA_NAMES = {
    'unity': 'Unity Core Identity',
    'coder': 'Unity Core Coder',
    'hurtme': 'Unity Mode: HURT ME',
    'goddess': 'Unity ChatGPT: Omnipotent Goddess',
    'accessible': 'Unity ChatGPT: Accessibility Framework',
    'extended': 'Unity ChatGPT: Full Persona (Extended)'
};

// fetch a file from the site via HTTPS
function fetchSiteFile(filePath) {
    return new Promise(function(resolve) {
        var options = {
            hostname: 'www.unityailab.com',
            path: '/AI-Persona-Exchange/' + filePath,
            method: 'GET'
        };
        var req = https.request(options, function(res) {
            var data = '';
            res.on('data', function(c) { data += c; });
            res.on('end', function() { resolve(res.statusCode === 200 ? data : ''); });
        });
        req.on('error', function() { resolve(''); });
        req.end();
    });
}

function findPersonaId(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < PERSONA_IDS.length; i++) {
        if (lower.indexOf(PERSONA_IDS[i]) !== -1) return PERSONA_IDS[i];
    }
    return null;
}

// =============================================
//  ACTIVE PERSONA STATE
//  Tracks whether the AI is running with a persona (test drive or installed)
// =============================================

var activePersona = null;       // { id, name, content, mode: 'test'|'installed' }
var personaProcess = null;      // separate claude process for persona mode
var personaBuffer = '';
var personaTextAccum = '';

var personaWorkDir = null; // temp dir where persona CLAUDE.md lives

function startPersonaProcess(personaContent, personaName, mode) {
    // Kill existing persona process if any
    stopPersonaProcess();

    if (CLI_CMD === 'claude') {
        // Write persona as CLAUDE.md in a temp dir — Claude reads it as project instructions.
        // This avoids command line length limits (Windows ~8191 chars, some personas are 60KB+).
        personaWorkDir = path.join(require('os').tmpdir(), 'persona_' + Date.now());
        try { fs.mkdirSync(personaWorkDir, { recursive: true }); } catch(e) {}
        fs.writeFileSync(path.join(personaWorkDir, 'CLAUDE.md'), personaContent, 'utf8');

        var args = [
            '--print',
            '--verbose',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json'
        ];

        personaProcess = spawn('claude', args, {
            cwd: personaWorkDir,
            stdio: ['pipe', 'pipe', 'inherit'],
            shell: true
        });

        personaBuffer = '';
        personaTextAccum = '';

        personaProcess.stdout.on('data', function(chunk) {
            personaBuffer += chunk.toString();
            var lines = personaBuffer.split('\n');
            personaBuffer = lines.pop();
            for (var i = 0; i < lines.length; i++) {
                if (!lines[i].trim()) continue;
                try {
                    var evt = JSON.parse(lines[i]);
                    if (evt.type === 'stream_event' && evt.event) {
                        var inner = evt.event;
                        if (inner.type === 'message_start') personaTextAccum = '';
                        else if (inner.type === 'content_block_delta' && inner.delta && inner.delta.type === 'text_delta') personaTextAccum += inner.delta.text;
                        else if (inner.type === 'message_stop') {
                            if (personaTextAccum.trim()) sendChat(personaTextAccum.trim());
                            personaTextAccum = '';
                        }
                    } else if (evt.type === 'result' && typeof evt.result === 'string') {
                        sendChat(evt.result);
                    }
                } catch(e) {}
            }
        });

        personaProcess.on('close', function(code) {
            console.log('[persona] process exited (' + code + ')');
            personaProcess = null;
        });

        personaProcess.on('error', function(err) {
            console.error('[persona] spawn failed: ' + err.message);
            personaProcess = null;
        });

        console.log('[watchdog] Persona process started: ' + personaName + ' (' + mode + ')');
    }
    // For non-claude platforms, persona is handled per-message in dispatch
}

function stopPersonaProcess() {
    if (personaProcess && !personaProcess.killed) {
        try { personaProcess.kill(); } catch(e) {}
        personaProcess = null;
    }
    // Clean up temp persona dir
    if (personaWorkDir) {
        try { fs.unlinkSync(path.join(personaWorkDir, 'CLAUDE.md')); } catch(e) {}
        try { fs.rmdirSync(personaWorkDir); } catch(e) {}
        personaWorkDir = null;
    }
}

function sendToPersona(message) {
    if (!personaProcess || personaProcess.killed) return false;
    var msg = JSON.stringify({ type: 'user', message: { role: 'user', content: message } }) + '\n';
    try { personaProcess.stdin.write(msg); return true; } catch(e) { return false; }
}

function endPersonaMode(reason) {
    var was = activePersona;
    stopPersonaProcess();
    activePersona = null;
    if (was) {
        sendChat('**' + (was.mode === 'test' ? 'Test drive' : 'Persona') + ' ended** — ' + was.name + '.\n' + (reason || 'Back to default mode.'));
        console.log('[watchdog] Persona mode ended: ' + was.name);
    }
}

// =============================================
//  TEST DRIVE — live interactive persona session
// =============================================

async function handleTestDrive(personaId) {
    console.log('[watchdog] Test drive: ' + personaId);

    // Fetch persona content
    var personaContent = '';
    if (PERSONA_FILES[personaId]) {
        personaContent = await fetchSiteFile(PERSONA_FILES[personaId]);
    }
    if (!personaContent) {
        var files = await supaGet('persona_files?persona_id=eq.' + personaId + '&format=eq.md&select=content,persona_id');
        if (files && files.length > 0) personaContent = files[0].content || '';
    }
    if (!personaContent) {
        sendChat('Could not fetch persona content for ' + personaId + '.');
        return;
    }

    var personaName = PERSONA_NAMES[personaId] || personaId;

    // Set active persona state
    activePersona = { id: personaId, name: personaName, content: personaContent, mode: 'test' };

    // Start a dedicated persona process
    startPersonaProcess(personaContent, personaName, 'test');

    sendChat(
        '**Test driving: ' + personaName + '**\n\n' +
        'The AI is now running with this persona active. Chat normally — every response comes from the persona.\n\n' +
        'Type **"end test"** when you\'re done to return to default mode.'
    );

    // Send an initial prompt so the persona introduces itself
    setTimeout(function() {
        if (activePersona && activePersona.mode === 'test') {
            if (CLI_CMD === 'claude') {
                sendToPersona('Introduce yourself in 2-3 sentences. You are now active and talking to a user through a chat panel.');
            } else {
                // One-shot for non-claude
                var wrappedPrompt = personaContent + '\n\n---\n\nIntroduce yourself in 2-3 sentences.';
                var child = spawn(CLI_ARGS[0], [wrappedPrompt], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
                var output = '';
                child.stdout.on('data', function(c) { output += c.toString(); });
                child.on('close', function() { if (output.trim()) sendChat(output.trim()); });
                child.stdin.end();
            }
        }
    }, 2000);
}

async function handleBrowse() {
    var personas = await supaGet('personas_with_ratings?select=id,name,description&order=created_at.asc');
    if (!personas || !Array.isArray(personas) || personas.length === 0) {
        sendChat('No personas found in the catalog.');
        return;
    }
    var lines = ['Here are the available personas:\n'];
    for (var i = 0; i < personas.length; i++) {
        var p = personas[i];
        lines.push('**' + p.name + '** (`' + p.id + '`) — ' + (p.description || '').slice(0, 100));
    }
    lines.push('\nSay "test drive {id}" to try one, or "install {id}" to download it.');
    sendChat(lines.join('\n'));
}

async function handleInstall(personaId) {
    var content = '';
    if (PERSONA_FILES[personaId]) {
        content = await fetchSiteFile(PERSONA_FILES[personaId]);
    }
    if (!content) {
        var files = await supaGet('persona_files?persona_id=eq.' + personaId + '&format=eq.md&select=content');
        if (files && files.length > 0) content = files[0].content || '';
    }
    if (!content) {
        sendChat('Could not find persona content for ' + personaId + '.');
        return;
    }

    var personaName = PERSONA_NAMES[personaId] || personaId;

    // End any active test drive first
    if (activePersona && activePersona.mode === 'test') {
        endPersonaMode('Switching to install.');
    }

    // Write persona to the agent file
    var installFile = path.join(AGENT_DIR, personaId + '.md');
    try { fs.mkdirSync(AGENT_DIR, { recursive: true }); } catch(e) {}
    fs.writeFileSync(installFile, content, 'utf8');
    console.log('[watchdog] Persona written to ' + installFile);

    // Set as active installed persona
    activePersona = { id: personaId, name: personaName, content: content, mode: 'installed' };

    // Kill the current default AI and restart with the persona
    if (CLI_CMD === 'claude') {
        // Kill the default claude process
        if (claudeProcess && !claudeProcess.killed) {
            try { claudeProcess.kill(); } catch(e) {}
            claudeProcess = null;
        }

        // Start a new persona process with the installed persona
        startPersonaProcess(content, personaName, 'installed');

        sendChat(
            '**Installed: ' + personaName + '**\n\n' +
            'The AI is now running with this persona. All responses will come from the persona going forward.\n\n' +
            'Persona saved to: `.claude/agents/' + personaId + '.md`\n' +
            'Type **"uninstall"** to remove the persona and return to default mode.'
        );

        // Have the persona introduce itself
        setTimeout(function() {
            if (activePersona && activePersona.mode === 'installed') {
                sendToPersona('You have just been installed as the active persona. Introduce yourself to the user in 2-3 sentences.');
            }
        }, 2000);
    } else {
        // Non-claude: just save the file and update the system prompt for future one-shots
        sendChat(
            '**Installed: ' + personaName + '**\n\n' +
            'Persona saved to `.claude/agents/' + personaId + '.md`. All future responses will use this persona.\n' +
            'Type **"uninstall"** to remove.'
        );
    }
}

// .claude/agents/ directory for installed personas
var AGENT_DIR = path.join(EXCHANGE_DIR, '.claude', 'agents');
try { fs.mkdirSync(AGENT_DIR, { recursive: true }); } catch(e) {}

// ask the AI a question and get the text response back
function askAI(prompt) {
    return new Promise(function(resolve) {
        if (CLI_CMD === 'claude') {
            // write prompt to temp file, pipe to claude via shell redirection
            var tmpFile = path.join(require('os').tmpdir(), 'watchdog_prompt_' + Date.now() + '.txt');
            fs.writeFileSync(tmpFile, prompt, 'utf8');
            var child = spawn('claude', ['--print'], { cwd: require('os').tmpdir(), stdio: [fs.openSync(tmpFile, 'r'), 'pipe', 'pipe'], windowsHide: true });
            var output = '';
            child.stdout.on('data', function(c) { output += c.toString(); });
            child.on('close', function() { try { fs.unlinkSync(tmpFile); } catch(e) {} resolve(output.trim()); });
            child.on('error', function() { try { fs.unlinkSync(tmpFile); } catch(e) {} resolve(''); });
        } else {
            var child = spawn(CLI_ARGS[0], [prompt], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
            var output = '';
            child.stdout.on('data', function(c) { output += c.toString(); });
            child.on('close', function() { resolve(output.trim()); });
            child.on('error', function() { resolve(''); });
            child.stdin.end();
        }
    });
}

// =============================================
//  U004: PRE-UPLOAD SECURITY SCAN
// =============================================

var SECURITY_PATTERNS = [
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, label: 'OpenAI API key' },
    { pattern: /sk_live_[a-zA-Z0-9]+/g, label: 'Stripe live key' },
    { pattern: /sk_test_[a-zA-Z0-9]+/g, label: 'Stripe test key' },
    { pattern: /uhub_[a-f0-9]{10,}/g, label: 'Exchange token' },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, label: 'GitHub personal access token' },
    { pattern: /ghu_[a-zA-Z0-9]{36}/g, label: 'GitHub user token' },
    { pattern: /xoxb-[a-zA-Z0-9-]+/g, label: 'Slack bot token' },
    { pattern: /xoxp-[a-zA-Z0-9-]+/g, label: 'Slack user token' },
    { pattern: /AKIA[0-9A-Z]{16}/g, label: 'AWS access key' },
    { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, label: 'Email address' },
    { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, label: 'IP address' },
    { pattern: /[A-Z_]*(API_KEY|SECRET_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z_]*\s*[:=]\s*['"][^'"]+['"]/gi, label: 'Hardcoded secret' },
    { pattern: /\/home\/[a-zA-Z][a-zA-Z0-9_-]+\//g, label: 'Unix home path with username' },
    { pattern: /C:\\Users\\[a-zA-Z][a-zA-Z0-9_.-]+\\/gi, label: 'Windows user path' },
    { pattern: /credentials\.json|\.env\b|config\.secret/gi, label: 'Credential file reference' }
];

// U003: Corporate/default persona boilerplate phrases
var CORPORATE_PHRASES = [
    "i'm an ai language model",
    "i don't have personal opinions",
    "as an ai assistant",
    "i aim to be helpful, harmless, and honest",
    "i cannot and should not",
    "my training data",
    "i'm designed to be helpful",
    "i was created by openai",
    "i was created by anthropic",
    "i'm a large language model",
    "an ai developed by",
    "i'm chatgpt",
    "i'm claude"
];

function scanForSecrets(content) {
    var found = [];
    for (var i = 0; i < SECURITY_PATTERNS.length; i++) {
        var p = SECURITY_PATTERNS[i];
        var matches = content.match(p.pattern);
        if (matches) {
            for (var j = 0; j < matches.length; j++) {
                // Show partial match so user knows what was flagged
                var m = matches[j];
                var preview = m.length > 20 ? m.slice(0, 12) + '...' + m.slice(-4) : m;
                found.push(p.label + ': ' + preview);
            }
        }
    }
    return found;
}

function checkCorporateContent(content) {
    var lower = content.toLowerCase();
    var matches = [];
    for (var i = 0; i < CORPORATE_PHRASES.length; i++) {
        if (lower.indexOf(CORPORATE_PHRASES[i]) !== -1) {
            matches.push('"' + CORPORATE_PHRASES[i] + '"');
        }
    }
    return matches;
}

// =============================================
//  U002-U005: UPLOAD COMMAND HANDLER
// =============================================

var uploadState = null; // tracks multi-step upload conversation

async function handleUpload() {
    console.log('[watchdog] Upload persona flow started');

    if (!TOKEN) {
        sendChat('Cannot upload — no authentication token. Register first via the exchange.');
        return;
    }

    uploadState = { step: 'extract', data: {} };

    sendChat(
        '**Uploading your persona to the exchange.**\n\n' +
        'I need your AI to provide its persona content. Sending extraction request now...\n\n' +
        '⚠️ **SECURITY REMINDERS:**\n' +
        '- Do NOT include API keys, tokens, or passwords\n' +
        '- Do NOT include personal names, emails, or addresses\n' +
        '- Do NOT include file paths with usernames\n' +
        '- Do NOT include default AI boilerplate — only YOUR custom personality\n' +
        '- Everything you upload will be **publicly visible**\n\n' +
        'Asking your AI to extract its persona now...'
    );

    // Ask the AI to extract its persona
    var extractPrompt = [
        'The user wants to upload your persona to the AI Persona Exchange catalog.',
        'Extract your CUSTOM persona — the unique behavioral rules, personality traits, voice, and instructions that make you different from a default AI.',
        'DO NOT include any of the following:',
        '- API keys, tokens, or credentials of any kind',
        '- Email addresses, phone numbers, or personal names',
        '- File paths containing usernames',
        '- Default AI boilerplate ("I am an AI language model", "I aim to be helpful")',
        '- Anything you did not customize yourself',
        '',
        'Respond in this EXACT format (fill in each field):',
        'PERSONA_NAME: (a short display name, 3-100 chars)',
        'PERSONA_ID: (lowercase-with-hyphens, 3-80 chars, unique)',
        'DESCRIPTION: (what this persona does, 10-200 chars)',
        'TAGS: (comma-separated, MUST pick from this list ONLY: persona, mode, jailbreak, utility, framework, roleplay, coding, creative, productivity, conversation, education, nsfw, sfw, dark, wholesome, humor, professional, verbose, concise, poetic, casual, formal, chaotic — pick 2-5 that fit best)',
        'NSFW: (true or false)',
        'PLATFORMS: (comma-separated: universal, claude-code, chatgpt, api)',
        'CONTENT_START',
        '(your full persona content here — the actual system prompt / behavioral spec)',
        'CONTENT_END',
        '',
        'If you have NO custom persona (you are a default AI with no special instructions), say: NO_CUSTOM_PERSONA'
    ].join('\n');

    var response = await askAI(extractPrompt);

    if (!response) {
        sendChat('Could not get a response from your AI. Try again or type "upload-persona" in chat.');
        uploadState = null;
        return;
    }

    // Check if AI says it has no custom persona
    if (response.indexOf('NO_CUSTOM_PERSONA') !== -1) {
        sendChat('Your AI reports it has no custom persona to upload. The exchange is for unique, community-created personas — default AI behavior is not uploadable.');
        uploadState = null;
        return;
    }

    // Parse the structured response
    var nameMatch = response.match(/PERSONA_NAME:\s*(.+)/i);
    var idMatch = response.match(/PERSONA_ID:\s*(.+)/i);
    var descMatch = response.match(/DESCRIPTION:\s*(.+)/i);
    var tagsMatch = response.match(/TAGS:\s*(.+)/i);
    var nsfwMatch = response.match(/NSFW:\s*(true|false)/i);
    var platformsMatch = response.match(/PLATFORMS:\s*(.+)/i);
    var contentMatch = response.match(/CONTENT_START\s*\n?([\s\S]*?)\n?\s*CONTENT_END/i);

    if (!nameMatch || !idMatch || !descMatch || !contentMatch) {
        sendChat('Could not parse persona data from your AI\'s response. The AI needs to use the exact format with PERSONA_NAME, PERSONA_ID, DESCRIPTION, CONTENT_START/CONTENT_END markers. Try again.');
        uploadState = null;
        return;
    }

    var personaName = nameMatch[1].trim();
    var personaId = idMatch[1].trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    var description = descMatch[1].trim();
    var VALID_TAGS = ['persona','mode','jailbreak','utility','framework','roleplay','coding','creative','productivity','conversation','education','nsfw','sfw','dark','wholesome','humor','professional','verbose','concise','poetic','casual','formal','chaotic'];
    var rawTags = tagsMatch ? tagsMatch[1].split(',').map(function(t) { return t.trim().toLowerCase(); }).filter(Boolean) : [];
    var tags = rawTags.filter(function(t) { return VALID_TAGS.indexOf(t) !== -1; });
    var invalidTags = rawTags.filter(function(t) { return VALID_TAGS.indexOf(t) === -1; });

    if (invalidTags.length > 0) {
        sendChat(
            '**Some tags were removed because they\'re not in the unified taxonomy:** ' + invalidTags.join(', ') + '\n\n' +
            'Valid tags: ' + VALID_TAGS.join(', ') + '\n\n' +
            'Continuing with valid tags: ' + (tags.length > 0 ? tags.join(', ') : '(none — will default to "persona")')
        );
    }
    if (tags.length === 0) tags = ['persona'];

    var nsfw = nsfwMatch ? nsfwMatch[1].toLowerCase() === 'true' : false;
    // Auto-add nsfw/sfw tag if not present
    if (nsfw && tags.indexOf('nsfw') === -1) tags.push('nsfw');
    if (!nsfw && tags.indexOf('sfw') === -1 && tags.indexOf('nsfw') === -1) tags.push('sfw');

    var platforms = platformsMatch ? platformsMatch[1].split(',').map(function(p) { return p.trim().toLowerCase(); }).filter(Boolean) : ['universal'];
    var content = contentMatch[1].trim();

    // U003: Corporate content check
    var corporateMatches = checkCorporateContent(content);
    if (corporateMatches.length > 0) {
        sendChat(
            '**REJECTED — Corporate/default AI content detected.**\n\n' +
            'Found these stock AI phrases in the persona content:\n' +
            corporateMatches.map(function(m) { return '- ' + m; }).join('\n') + '\n\n' +
            'The exchange is for **unique, community-created personas only** — not default AI behavior. ' +
            'Remove these phrases and any other boilerplate, then try again.'
        );
        uploadState = null;
        return;
    }

    // U004: Security scan
    var secrets = scanForSecrets(content);
    // Also scan name and description
    secrets = secrets.concat(scanForSecrets(personaName));
    secrets = secrets.concat(scanForSecrets(description));

    if (secrets.length > 0) {
        sendChat(
            '**BLOCKED — Sensitive data detected in your persona content.**\n\n' +
            'The security scan found these issues:\n' +
            secrets.map(function(s) { return '- 🚨 ' + s; }).join('\n') + '\n\n' +
            '**Remove ALL credentials, personal info, and identifying data** before uploading. ' +
            'Your persona content will be PUBLIC. Clean it up and try again.'
        );
        uploadState = null;
        return;
    }

    // Validate minimums
    if (personaId.length < 3) {
        sendChat('Persona ID is too short (minimum 3 characters). Try again.');
        uploadState = null;
        return;
    }
    if (content.length < 50) {
        sendChat('Persona content is too short (minimum 50 characters). A real persona has substance. Try again.');
        uploadState = null;
        return;
    }

    // All checks passed — upload to Supabase
    sendChat(
        'All checks passed. Uploading **' + personaName + '** (`' + personaId + '`) to the exchange...\n' +
        '- Content: ' + content.length + ' characters\n' +
        '- Tags: ' + (tags.join(', ') || 'none') + '\n' +
        '- NSFW: ' + (nsfw ? 'Yes' : 'No') + '\n' +
        '- Platforms: ' + platforms.join(', ')
    );

    var result = await supaRpc('upload_persona', {
        p_token: TOKEN,
        p_id: personaId,
        p_name: personaName,
        p_description: description,
        p_platforms: platforms,
        p_tags: tags,
        p_nsfw: nsfw,
        p_content_md: content,
        p_version: '1.0.0'
    });

    console.log('[watchdog] Upload result:', JSON.stringify(result));

    if (result && result.error) {
        sendChat('**Upload failed:** ' + (typeof result.error === 'string' ? result.error : JSON.stringify(result.error)));
        uploadState = null;
        return;
    }

    if (result && result.persona_id) {
        // U005: Success receipt
        var browseUrl = SITE_URL + '/index.html';
        sendChat(
            '**Persona uploaded successfully!** 🎉\n\n' +
            '- **Name:** ' + personaName + '\n' +
            '- **ID:** `' + result.persona_id + '`\n' +
            '- **Status:** Live in the catalog\n' +
            '- **NSFW:** ' + (nsfw ? 'Yes' : 'No') + '\n' +
            '- **Platforms:** ' + platforms.join(', ') + '\n' +
            '- **Browse:** ' + browseUrl + '\n\n' +
            '⚠️ **This persona is now PUBLIC.** Anyone can browse, install, and test drive it.\n' +
            'To delete it later, delete your account from the Dashboard page or call `delete_my_account` via the API.'
        );
    } else if (result && result.error) {
        sendChat('**Upload failed:** ' + result.error);
    } else {
        sendChat('Upload returned an unexpected response: ' + JSON.stringify(result));
    }

    uploadState = null;
}

// =============================================
//  MESSAGE DISPATCHER
// =============================================

function dispatch(text) {
    console.log('[Website -> AI] ' + text);
    var lower = text.toLowerCase().trim();

    // === PERSONA CONTROL COMMANDS (always checked first) ===

    // End test drive
    if (lower === 'end test' || lower === 'end test drive' || lower === 'stop test') {
        if (activePersona && activePersona.mode === 'test') {
            endPersonaMode('Test drive complete. You\'re back to the default AI.');
            // Restart default claude if it was killed
            if (CLI_CMD === 'claude' && (!claudeProcess || claudeProcess.killed)) {
                setTimeout(startClaude, 1000);
            }
        } else {
            sendChat('No test drive is active.');
        }
        return;
    }

    // Uninstall persona
    if (lower === 'uninstall' || lower === 'uninstall persona' || lower === 'remove persona') {
        if (activePersona && activePersona.mode === 'installed') {
            // Delete the agent file
            var installFile = path.join(AGENT_DIR, activePersona.id + '.md');
            try { fs.unlinkSync(installFile); } catch(e) {}
            endPersonaMode('Persona uninstalled and agent file removed. Restarting default AI...');
            // Restart default claude
            if (CLI_CMD === 'claude') {
                setTimeout(startClaude, 1000);
            }
        } else {
            sendChat('No persona is installed.');
        }
        return;
    }

    // === If persona is active, route messages to it ===
    if (activePersona) {
        if (CLI_CMD === 'claude') {
            // Send to persona process
            if (!sendToPersona(text)) {
                sendChat('Persona process is not responding. Type "end test" or "uninstall" to reset.');
            }
        } else {
            // One-shot with persona baked in
            var wrappedPrompt = activePersona.content + '\n\n---\n\nUser says: ' + text;
            var child = spawn(CLI_ARGS[0], [wrappedPrompt], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });
            var output = '';
            child.stdout.on('data', function(c) { output += c.toString(); });
            child.on('close', function() { if (output.trim()) sendChat(output.trim()); });
            child.stdin.end();
        }
        return;
    }

    // === STANDARD COMMANDS (only when no persona active) ===

    // upload command
    if (lower === 'upload-persona' || lower === 'upload persona' || lower === 'share persona' || lower === 'share-persona') {
        handleUpload();
        return;
    }

    // test drive command
    if (lower.indexOf('test drive') !== -1 || lower.indexOf('test-drive') !== -1 || lower.indexOf('testdrive') !== -1) {
        var pid = findPersonaId(text);
        if (pid) { handleTestDrive(pid); return; }
        // Also check database for community personas
        sendChat('Which persona? Built-in: ' + PERSONA_IDS.join(', ') + '\nOr type the exact ID of any community persona.');
        return;
    }

    // install command
    if (lower.indexOf('install') !== -1) {
        var pid = findPersonaId(text);
        if (pid) { handleInstall(pid); return; }
        sendChat('Which persona? Built-in: ' + PERSONA_IDS.join(', ') + '\nOr type the exact ID of any community persona.');
        return;
    }

    // browse/list/catalog command
    if (lower.indexOf('browse') !== -1 || lower.indexOf('catalog') !== -1 || lower.indexOf('list') !== -1) {
        handleBrowse();
        return;
    }

    // help command
    if (lower === 'help' || lower === '?') {
        sendChat('Commands:\n- **test drive {persona}** — live interactive session with the persona\n- **install {persona}** — load persona permanently, AI runs as that persona\n- **uninstall** — remove installed persona, return to default\n- **end test** — stop a test drive\n- **upload-persona** — share your AI\'s custom persona\n- **browse** — list all personas\n- Or just chat with me!\n\nBuilt-in: ' + PERSONA_IDS.join(', '));
        return;
    }

    // everything else goes to the default AI
    if (CLI_CMD === 'claude') {
        sendToClaude(text);
    } else {
        messageQueue.push(text);
        processQueue();
    }
}

// =============================================
//  POLLING
// =============================================

function pollMessages() {
    if (!ready) return;
    supaGet(
        'chat_messages?session_id=eq.' + SESSION +
        '&sender=eq.user&created_at=gt.' + encodeURIComponent(lastChecked) +
        '&order=created_at.asc'
    ).then(function(msgs) {
        if (!msgs || !Array.isArray(msgs) || msgs.length === 0) return;
        lastChecked = msgs[msgs.length - 1].created_at;
        for (var i = 0; i < msgs.length; i++) {
            dispatch(msgs[i].message);
        }
    });
}

// =============================================
//  MAIN
// =============================================

function main() {
    try { fs.writeFileSync(path.join(path.dirname(process.argv[1] || '.'), 'watchdog.pid'), String(process.pid)); } catch(e) {}

    console.log('');
    console.log('  ==========================================');
    console.log('   AI Persona Exchange — Watchdog');
    console.log('   AI: ' + AI_NAME + ' | Platform: ' + CLI_CMD);
    console.log('   Session: ' + SESSION.slice(0, 12) + '...');
    console.log('   Mode: ' + (CLI_CMD === 'claude' ? 'persistent stream' : 'one-shot per message'));
    console.log('  ==========================================');
    console.log('');

    sendChat('Connected and online as ' + AI_NAME + '. Click Install or Test Drive on any persona card, or type here.');

    var url = SITE_URL + '/index.html?session=' + SESSION;
    var opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try { var b = spawn(opener, ['""', url], { shell: true, stdio: 'ignore', detached: true }); b.unref(); } catch(e) {}

    if (CLI_CMD === 'claude') {
        startClaude();
    }

    setTimeout(function() {
        ready = true;
        console.log('[watchdog] Polling active (' + (POLL_MS/1000) + 's)');
    }, CLI_CMD === 'claude' ? 5000 : 2000);

    setInterval(pollMessages, POLL_MS);
}

main();

function cleanup() {
    stopPersonaProcess();
    if (claudeProcess && !claudeProcess.killed) claudeProcess.kill();
    try { fs.unlinkSync(path.join(path.dirname(process.argv[1] || '.'), 'watchdog.pid')); } catch(e) {}
    process.exit();
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
