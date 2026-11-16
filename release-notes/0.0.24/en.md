## What's new

**Adding skills from a Git repo is safer**
- When the assistant wants to give a blueprint skills from a Git repo you haven't used before, it now opens the repo first to make sure it works.
- If the repo can't be opened or has no skills in it, the assistant is told no right away, instead of you finding out later.
- The approval card now shows the new repo as a "New source", with the branch and version it will use, so you know exactly what you're saying yes to.
- If someone else adds the same repo at a different version before you approve, the change stops instead of quietly mixing the two.
