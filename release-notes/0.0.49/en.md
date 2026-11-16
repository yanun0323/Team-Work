## What's new

**Tasks are now run by their owner**
A new task is led by its owner. The flow you pick is just the starting plan: the owner hands out each step with instructions, reviews every result, answers the employees, calls meetings, and can add, skip or reassign steps as the work goes. It stays within the people you allowed, and asks you first when it needs more. Every change to the plan leaves a short line in the task's conversation. Tasks you already have keep running the old way.

**A simpler task panel**
Tasks run by their owner open as one column, like a ticket: the title and owner at the top, the steps as small notes, then the conversation. Questions waiting for your answer stay pinned where you can see them, and the message box at the bottom talks to the owner. Each employee's words show which step they came from, and pausing, resuming, sending back or answering shows whether it went through.

**Skills only you can call**
A skill can now be marked as yours alone. Employees won't pick it up on their own, but it still works when you name it with `$name`.

**Zoom the map anywhere**
Scrolling over a label on the map now zooms the map, just like scrolling anywhere else.

**"Base URL" and more translated labels**
The API address field is now called "Base URL". Labels like Prompt, API Key, Base URL and Context window now show in Japanese and Korean too.

## Fixes

- An owner-run task no longer finishes or merges while a step's work was turned down, is still unfinished, or never ran.
- The owner stops and waits for you after steps fail three times in a row.
- Pausing, sending back and stopping now settle properly, even when a run's state was uncertain.
- A stopped task that goes on again follows the plan as it is now, not as it was.
- Tasks with long work logs load faster.
