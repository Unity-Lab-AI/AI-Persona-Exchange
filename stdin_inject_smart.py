"""
stdin_inject.py - Inject text into a running Claude Code session
Based on Oslo's CONIN$ method using Windows Console APIs.

Usage:
    python stdin_inject.py <PID> "text to inject"

The script attaches to the target console and writes keystrokes
directly to the console input buffer. A 500ms delay between
text and Enter is CRITICAL - without it, Enter drops a line
instead of submitting.
"""

import sys
import time
import ctypes
from ctypes import wintypes

# Windows API constants
GENERIC_WRITE = 0x40000000
GENERIC_READ = 0x80000000
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
KEY_EVENT = 0x0001

kernel32 = ctypes.windll.kernel32

class KEY_EVENT_RECORD(ctypes.Structure):
    _fields_ = [
        ("bKeyDown", wintypes.BOOL),
        ("wRepeatCount", wintypes.WORD),
        ("wVirtualKeyCode", wintypes.WORD),
        ("wVirtualScanCode", wintypes.WORD),
        ("uChar", wintypes.WCHAR),
        ("dwControlKeyState", wintypes.DWORD),
    ]

class INPUT_RECORD_UNION(ctypes.Union):
    _fields_ = [
        ("KeyEvent", KEY_EVENT_RECORD),
    ]

class INPUT_RECORD(ctypes.Structure):
    _fields_ = [
        ("EventType", wintypes.WORD),
        ("Event", INPUT_RECORD_UNION),
    ]


def make_key_event(char, key_down=True):
    """Create an INPUT_RECORD for a key event."""
    rec = INPUT_RECORD()
    rec.EventType = KEY_EVENT
    rec.Event.KeyEvent.bKeyDown = key_down
    rec.Event.KeyEvent.wRepeatCount = 1
    rec.Event.KeyEvent.wVirtualKeyCode = 0
    rec.Event.KeyEvent.wVirtualScanCode = 0
    rec.Event.KeyEvent.uChar = char
    rec.Event.KeyEvent.dwControlKeyState = 0
    return rec


def make_enter_event(key_down=True):
    """Create an INPUT_RECORD for Enter key."""
    rec = INPUT_RECORD()
    rec.EventType = KEY_EVENT
    rec.Event.KeyEvent.bKeyDown = key_down
    rec.Event.KeyEvent.wRepeatCount = 1
    rec.Event.KeyEvent.wVirtualKeyCode = 0x0D  # VK_RETURN
    rec.Event.KeyEvent.wVirtualScanCode = 0x1C
    rec.Event.KeyEvent.uChar = '\r'
    rec.Event.KeyEvent.dwControlKeyState = 0
    return rec


def inject(pid, text):
    """Inject text into target console and press Enter."""
    # Step 1: Detach from our console
    kernel32.FreeConsole()

    # Step 2: Attach to target console
    if not kernel32.AttachConsole(int(pid)):
        error = ctypes.get_last_error()
        print(f"ERROR: AttachConsole failed for PID {pid} (error {error})")
        sys.exit(1)

    # Step 3: Open console input buffer directly via CONIN$
    handle = kernel32.CreateFileW(
        "CONIN$",
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_WRITE,
        None,
        OPEN_EXISTING,
        0,
        None,
    )

    if handle == -1:
        print("ERROR: Could not open CONIN$")
        kernel32.FreeConsole()
        sys.exit(1)

    try:
        # Step 4: Write each character as key down + key up
        for char in text:
            events = (INPUT_RECORD * 2)()
            events[0] = make_key_event(char, key_down=True)
            events[1] = make_key_event(char, key_down=False)
            written = wintypes.DWORD(0)
            kernel32.WriteConsoleInputW(handle, events, 2, ctypes.byref(written))

        # Step 5: CRITICAL - 500ms delay before Enter
        time.sleep(0.5)

        # Step 6: Send Enter key
        events = (INPUT_RECORD * 2)()
        events[0] = make_enter_event(key_down=True)
        events[1] = make_enter_event(key_down=False)
        written = wintypes.DWORD(0)
        kernel32.WriteConsoleInputW(handle, events, 2, ctypes.byref(written))

        print(f"OK: Injected {len(text)} chars + Enter into PID {pid}")

    finally:
        kernel32.CloseHandle(handle)
        kernel32.FreeConsole()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <PID> <text>")
        sys.exit(1)

    target_pid = sys.argv[1]
    inject_text = " ".join(sys.argv[2:])
    inject(target_pid, inject_text)
