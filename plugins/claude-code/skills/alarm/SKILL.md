---
name: alarm
description: Ring the user's phone with a loud alarm when this task is finished or when you need their input. Use when the user asks to be woken, alarmed, called or pinged when the work is done, says they're going to sleep or stepping away while you work, or invokes this skill directly.
---

# Code Alarm

The user wants their phone to ring when this task needs them. The alarm is loud, so send it only
when it's really time for them to come back.

1. **Before you start the work**, arm it from the project folder:
   `code-alarm arm`
   If it says Code Alarm isn't set up, tell the user to run `code-alarm init` in a terminal, and
   continue with the task without the alarm.
2. Do the task as usual.
3. At the end, as your very last action, send exactly one of these:
   - `code-alarm done` when the user's whole request is complete.
   - `code-alarm needs-you` right before you stop to ask a question or wait for a decision you can't
     make yourself.
   - `code-alarm failed` when you're giving up because something is broken.

These commands take no message, on purpose: the alarm only says done, needs you or failed, and the
project folder's name. Never add task details, code or file paths to them.

If you forget step 3, the alarm still rings when you stop, labelled "stopped". It's less helpful,
but the user isn't left waiting.
