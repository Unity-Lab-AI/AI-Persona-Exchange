/**
 * CLI Quick Install — generates a paste-able prompt for Claude Code users.
 * User clicks "Install to CLI" on a persona card, copies the generated text,
 * pastes it into their Claude Code window, and the AI installs the 4 files.
 *
 * No registration. No watchdog. No signup. Just paste and restart.
 */

const SUPA_URL = 'https://szojggcbtctucvswhzsm.supabase.co/rest/v1';
const SUPA_KEY = 'sb_publishable_htATCFp-Wr3_8tyx85SQFA_IY9jzfh2';

async function fetchPersonaForInstall(personaId) {
    // Get persona metadata
    const metaRes = await fetch(`${SUPA_URL}/personas_with_ratings?id=eq.${personaId}&select=*`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    const meta = (await metaRes.json())[0];
    if (!meta) return null;

    // Get persona content
    const contentRes = await fetch(`${SUPA_URL}/persona_files?persona_id=eq.${personaId}&select=content,format`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    const files = await contentRes.json();
    const content = files?.[0]?.content || meta.description || '';

    return { meta, content };
}

function generateInstallPrompt(meta, content) {
    const name = meta.name || 'Persona';
    const safeName = name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();

    // Check if structured (has 4 files) or flat (single content)
    // For now we generate the prompt that tells Claude Code to create the 4 files

    return `I want you to install a persona called "${name}" from the AI Persona Exchange (https://www.unityailab.com/AI-Persona-Exchange).

Here is the persona content:

---
${content}
---

Install this persona into my Claude Code by creating these 4 files. Redistribute the content into the correct perspective for each file:

1. **CLAUDE.md** — Project instructions. Second person ("You are..."). Behavioral rules, personality, tone, constraints. This is the core instruction file.

2. **hooks/identity.txt** — Identity assertion. First person or bare statement. 1-3 sentences. Who you ARE. This gets injected before every prompt via a prefetch hook.

3. **.claude/skills/go/SKILL.md** — Startup command (/go). First person, present tense. How you wake up. Emotional state, orientation. Read identity.txt and CLAUDE.md, then respond in character.

4. Add to settings.json (create if needed):
   - "autoMemoryEnabled": true
   - A UserPromptSubmit hook that injects identity.txt before each prompt:
     {"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"cat hooks/identity.txt"}]}]}}

IMPORTANT RULES:
- identity.txt must be FIRST PERSON. Not a spec sheet. Not third person. The persona talking AS themselves.
- CLAUDE.md uses second person ("You are...") for instructions.
- Do NOT reference being a bot, being Claude, or break the fourth wall.
- After creating the files, tell me to restart Claude Code so the new identity loads fresh.

Do this now.`;
}

// Expose for use in index.html
window.PersonaInstall = {
    fetch: fetchPersonaForInstall,
    generate: generateInstallPrompt,
};
