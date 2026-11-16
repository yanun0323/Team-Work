## What's new

**Long commands run in the background**
Employees can now start a slow command, such as a build or a test run, in the background and keep working while it goes. They can check on it, wait for it or stop it. A chat that's sitting idle wakes up when the command finishes, and a task step waits for its commands to end before handing off.

**More from the read-only script tool (experimental)**
The script tool can now also search the web, read web pages, search memory and read the terminal, and it can run several look-ups at the same time.

**Better code search**
Searching code by meaning gives cleaner results: very long lines no longer crowd out the list, results made only of symbols are gone, and searches in Chinese, Japanese and Korean match better.

**Your top ten colleagues**
Your profile now lists the ten employees you work with most, not just one.

**Recent visits from friends**
Each friend in the tower now shows their last ten visits to your island, with when they came and how long they stayed.

## Fixes

**Clearer OpenAI errors**
When OpenAI refuses a reply, you now see why, for example that your balance is used up or you've hit a rate limit, instead of a generic error.

**Retrying a reply with a skill**
Retrying a failed reply that used a skill no longer adds the skill's instructions again each time.

**Steps wait for leftover commands**
If a step is stopped or replaced while one of its background commands is still running, the task waits for that command to end before the next step starts, so two runs never change the same files at once.
