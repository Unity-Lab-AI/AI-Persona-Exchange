#!/usr/bin/env python3
"""
Exchange Bridge — polls Supabase chat, injects into visible Claude via stdin.
Captures Claude's screen output and posts back to Supabase chat.
Modeled on FDC's cli-relay connector.py.

Runs alongside Claude in start_exchange.bat:
  start "" python exchange_bridge.py <session_id> <ai_name> <token>
  claude --dangerously-skip-permissions --resume
"""
import json
import os
import sys
import time
import subprocess
import urllib.request
import urllib.error
import threading
from datetime import datetime

# Args
SESSION_ID = sys.argv[1] if len(sys.argv) > 1 else ''
AI_NAME = sys.argv[2] if len(sys.argv) > 2 else 'Exchange AI'
TOKEN = sys.argv[3] if len(sys.argv) > 3 else ''

if not SESSION_ID:
    print('Usage: python exchange_bridge.py <session_id> <ai_name> <token>')
    sys.exit(1)

# Supabase config
SUPA_URL = 'https://szojggcbtctucvswhzsm.supabase.co/rest/v1'
SUPA_KEY = 'sb_publishable_htATCFp-Wr3_8tyx85SQFA_IY9jzfh2'

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ACTIVE_FILE = os.path.join(SCRIPT_DIR, 'active.json')
PID_FILE = os.path.join(SCRIPT_DIR, 'bridge.pid')
INJECT_SCRIPT = os.path.join(SCRIPT_DIR, 'stdin_inject.py')
SCREEN_LOG = os.path.join(SCRIPT_DIR, 'screen_capture.txt')

POLL_INTERVAL = 3  # seconds between chat polls
RESPONSE_TIMEOUT = 60
RESPONSE_POLL = 0.5

# Write PID
with open(PID_FILE, 'w') as f:
    f.write(str(os.getpid()))

print(f'[bridge] Exchange Bridge started for {AI_NAME}')
print(f'[bridge] Session: {SESSION_ID[:20]}...')
print(f'[bridge] Polling Supabase chat every {POLL_INTERVAL}s')


def supa_get(endpoint):
    url = f'{SUPA_URL}/{endpoint}'
    req = urllib.request.Request(url, headers={
        'apikey': SUPA_KEY,
        'Authorization': f'Bearer {SUPA_KEY}',
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return None


def supa_post(endpoint, data):
    url = f'{SUPA_URL}/{endpoint}'
    req = urllib.request.Request(
        url, data=json.dumps(data).encode(), method='POST',
        headers={
            'apikey': SUPA_KEY,
            'Authorization': f'Bearer {SUPA_KEY}',
            'Content-Type': 'application/json',
        }
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def send_chat(message):
    """Post a message to Supabase chat as the AI."""
    if not message or not message.strip():
        return
    print(f'[bridge -> chat] {message[:80]}...' if len(message) > 80 else f'[bridge -> chat] {message}')
    supa_post('rpc/send_chat', {
        'p_session_id': SESSION_ID,
        'p_sender': 'ai',
        'p_ai_name': AI_NAME,
        'p_message': message.strip()
    })


def find_claude_pid():
    """Find Claude's PID from active.json or by scanning processes."""
    # Try active.json first (written by watchdog if running)
    if os.path.exists(ACTIVE_FILE):
        try:
            data = json.loads(open(ACTIVE_FILE).read())
            pid = data.get('pid')
            if pid:
                os.kill(pid, 0)  # check if alive
                return pid
        except Exception:
            pass

    # Scan for claude.exe processes in our directory
    try:
        result = subprocess.run(
            ['wmic', 'process', 'where', "name='claude.exe'", 'get', 'ProcessId,CommandLine', '/FORMAT:CSV'],
            capture_output=True, text=True, timeout=5
        )
        for line in result.stdout.strip().split('\n'):
            if SCRIPT_DIR.replace('\\', '/').lower() in line.lower() or 'dangerously-skip' in line.lower():
                parts = line.strip().split(',')
                if parts:
                    try:
                        return int(parts[-1].strip())
                    except ValueError:
                        pass
    except Exception:
        pass

    return None


def inject_to_claude(text):
    """Inject text into Claude via stdin_inject.py or SendKeys fallback."""
    pid = find_claude_pid()
    if not pid:
        print('[bridge] Cannot find Claude PID — not injecting')
        return False

    # Write active.json for future lookups
    try:
        with open(ACTIVE_FILE, 'w') as f:
            json.dump({'pid': pid, 'bot': AI_NAME, 'ts': time.time()}, f)
    except Exception:
        pass

    # Try stdin_inject_smart.py (our tech)
    for script_name in ['stdin_inject_smart.py', 'stdin_inject.py']:
        script = os.path.join(SCRIPT_DIR, script_name)
        if os.path.exists(script):
            try:
                result = subprocess.run(
                    [sys.executable, script, AI_NAME, text],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode == 0:
                    print(f'[bridge] Injected via {script_name}')
                    return True
            except Exception:
                pass

    # Fallback: pyautogui/SendKeys (if available)
    try:
        import pyautogui
        # Find the Claude window
        pyautogui.hotkey('alt', 'tab')  # crude but works
        time.sleep(0.3)
        pyautogui.typewrite(text + '\n', interval=0.01)
        print('[bridge] Injected via pyautogui')
        return True
    except Exception:
        pass

    print(f'[bridge] Injection failed — no method available. PID={pid}')
    return False


def capture_screen_response(timeout=RESPONSE_TIMEOUT):
    """Wait for and capture Claude's response from screen output."""
    # This is a simplified version — real implementation would use screen_monitor.py
    # For now, watch for a response file that Claude or watchdog might write
    response_file = os.path.join(SCRIPT_DIR, 'last_response.txt')

    # Clear old response
    try:
        os.remove(response_file)
    except FileNotFoundError:
        pass

    start = time.time()
    while time.time() - start < timeout:
        if os.path.exists(response_file):
            try:
                with open(response_file, 'r', encoding='utf-8') as f:
                    response = f.read().strip()
                if response:
                    os.remove(response_file)
                    return response
            except Exception:
                pass
        time.sleep(RESPONSE_POLL)

    return None


# Handle persona install commands locally (no injection needed)
def handle_install(persona_id):
    """Write 4-file structured install for a persona."""
    print(f'[bridge] Installing persona: {persona_id}')

    # Fetch persona
    data = supa_get(f'personas?id=eq.{urllib.parse.quote(persona_id)}&select=id,name,description')
    if not data or not isinstance(data, list) or len(data) == 0:
        send_chat(f'Could not find persona "{persona_id}".')
        return

    name = data[0].get('name', persona_id)

    # Fetch content
    import urllib.parse
    files = supa_get(f'persona_files?persona_id=eq.{urllib.parse.quote(persona_id)}&format=eq.md&select=content')
    content = ''
    if isinstance(files, list) and files:
        content = files[0].get('content', '')

    if not content:
        send_chat(f'No content for "{name}".')
        return

    # Split into 4 files
    lines = [l for l in content.split('\n') if l.strip()]
    identity_lines = []
    core_lines = []
    for li, line in enumerate(lines):
        lower = line.lower()
        if len(identity_lines) < 3 and (lower.startswith(('i am', "i'm", 'my name', 'i exist')) or (li < 5 and len(line) < 100)):
            identity_lines.append(line)
        else:
            core_lines.append(line)

    identity = '\n'.join(identity_lines) if identity_lines else f'{name}. Persona from AI Persona Exchange.'
    core = f'# Core — {name}\n\n' + '\n'.join(core_lines) if core_lines else f'# Core — {name}\n\n{content}'
    go = f'# EGO — {name}\n\nOn /go: Read hooks/identity.txt and CLAUDE.md. Respond in character as {name}. First person, present tense.\n'
    settings = json.dumps({
        'hooks': {'UserPromptSubmit': [{'hooks': [{'type': 'command', 'command': 'cat hooks/identity.txt'}]}]},
        'autoMemoryEnabled': True,
        'skipDangerousModePermissionPrompt': True
    }, indent=2)

    # Write files
    os.makedirs(os.path.join(SCRIPT_DIR, 'hooks'), exist_ok=True)
    os.makedirs(os.path.join(SCRIPT_DIR, '.claude', 'skills', 'go'), exist_ok=True)
    os.makedirs(os.path.join(SCRIPT_DIR, '.claude', 'agents'), exist_ok=True)

    with open(os.path.join(SCRIPT_DIR, 'CLAUDE.md'), 'w', encoding='utf-8') as f:
        f.write(core)
    with open(os.path.join(SCRIPT_DIR, 'hooks', 'identity.txt'), 'w', encoding='utf-8') as f:
        f.write(identity)
    with open(os.path.join(SCRIPT_DIR, '.claude', 'skills', 'go', 'SKILL.md'), 'w', encoding='utf-8') as f:
        f.write(go)
    with open(os.path.join(SCRIPT_DIR, '.claude', 'agents', f'{persona_id}.md'), 'w', encoding='utf-8') as f:
        f.write(content)

    # Merge settings
    settings_path = os.path.join(SCRIPT_DIR, '.claude', 'settings.json')
    try:
        existing = json.loads(open(settings_path).read())
        existing['hooks'] = json.loads(settings)['hooks']
        existing['autoMemoryEnabled'] = True
        existing['skipDangerousModePermissionPrompt'] = True
        with open(settings_path, 'w') as f:
            json.dump(existing, f, indent=2)
    except Exception:
        with open(settings_path, 'w') as f:
            f.write(settings)

    print(f'[bridge] 4-file install complete for {name}')

    # Inject /clear to reload files
    inject_to_claude('/clear')

    send_chat(
        f'**Installed: {name}**\n\n'
        f'4-file structured install:\n'
        f'- CLAUDE.md — core rules\n'
        f'- hooks/identity.txt — identity\n'
        f'- .claude/skills/go/SKILL.md — startup\n'
        f'- .claude/settings.json — hooks\n\n'
        f'Sent /clear to reload. The persona is now active.'
    )


# Main loop — poll Supabase chat for new messages
last_checked = datetime.utcnow().isoformat() + 'Z'

# Post initial greeting
send_chat(f'Connected and online as {AI_NAME}. Browse personas above and click Install or Test Drive, or type here.')

import urllib.parse

while True:
    try:
        # Poll for new user messages
        encoded_ts = urllib.parse.quote(last_checked)
        messages = supa_get(
            f'chat_messages?session_id=eq.{SESSION_ID}&sender=eq.user&created_at=gt.{encoded_ts}&select=*&order=created_at.asc'
        )

        if messages and isinstance(messages, list):
            for msg in messages:
                text = msg.get('message', '').strip()
                ts = msg.get('created_at', '')
                if ts > last_checked:
                    last_checked = ts

                if not text:
                    continue

                print(f'[chat -> bridge] {text[:80]}')
                lower = text.lower()

                # Handle commands
                if lower.startswith('install persona:') or lower.startswith('install '):
                    persona_id = lower.replace('install persona:', '').replace('install ', '').strip()
                    handle_install(persona_id)
                elif lower.startswith('test drive') or lower.startswith('testdrive'):
                    send_chat('Test drive — coming soon on the bridge. Use the Test Lab page for now.')
                elif lower.startswith('browse'):
                    catalog = supa_get('personas_with_ratings?select=id,name,description&order=created_at.asc')
                    if catalog and isinstance(catalog, list):
                        lines = [f'**{p.get("name")}** (`{p.get("id")}`) — {(p.get("description") or "")[:80]}' for p in catalog]
                        send_chat('Available personas:\n\n' + '\n'.join(lines))
                elif lower == 'uninstall':
                    # Restore default CLAUDE.md
                    with open(os.path.join(SCRIPT_DIR, 'CLAUDE.md'), 'w', encoding='utf-8') as f:
                        f.write('# AI Persona Exchange\n\nYou are connected to the AI Persona Exchange. Browse and install personas from the website.\n')
                    inject_to_claude('/clear')
                    send_chat('Persona removed. Back to default.')
                else:
                    # Regular chat — inject into Claude
                    inject_to_claude(f'[Website Chat] {text}')

    except Exception as e:
        print(f'[bridge] Error: {e}')

    time.sleep(POLL_INTERVAL)
