// The help in English, topic by topic. Help.tsx has the same topics in Chinese, and a test keeps the two matched.

import type { ReactNode } from 'react'

export const HELP_EN: Record<string, { label: string; title?: string; alt: string; body: ReactNode }> = {
  start: {
    label: 'Quick start',
    alt: 'Two companies and the airport on the island; at the top right, the noticeboard, new company, edit map, language, help and settings (plane) buttons',
    body: (
      <>
        <p>Team Work treats each project as a company, in a building on the island. The company's employees are AI agents who follow a workflow step by step to finish the tasks you give them.</p>
        <ol>
          <li>In Airport → Model providers, connect at least one provider, so employees have models to use.</li>
          <li>Press ＋ New company, pick a spot on the map, then fill in the project folder, name and target branch.</li>
          <li>On the company's Employees tab, add employees: pick a blueprint and a model. Blueprints and workflows come built in, ready to use.</li>
          <li>On the Tasks tab, create a task: write what to do, pick a workflow, then choose employees for each step (the task owner does Clarify requirements and Acceptance review).</li>
          <li>Employees work through the workflow in turn. Open the task and look at Progress: a step with a red exclamation mark is waiting for you. Open it to reply.</li>
        </ol>
        <p>When something is missing, a stamp on the company's tabs says what to do first. Drag the map to move the view. Press Esc or click the map to put away what is open. To change the language, press the globe at the top right.</p>
      </>
    ),
  },
  map: {
    label: 'Map',
    alt: 'Editing the map: a dashed plot follows the cursor for the selected company',
    body: (
      <>
        <p>Each building on the island is a company, and you decide where it goes. While you pick a spot, the note at the top middle says what to pick, and the translucent green area beside the dashed frame is the land that would grow.</p>
        <dl>
          <dt>Move the view</dt><dd>Drag the map, or use WASD or the arrow keys (hold Shift to go faster). Scroll to zoom: in toward the cursor, out from the middle of the screen.</dd>
          <dt>＋ New company</dt><dd>A dashed frame follows the cursor and can go on land or sea. It turns red when it is too crowded or too far from shore. On the sea, land grows to join it to the island. Once placed, you see a preview of the building. Its look is random, and the die picks another.</dd>
          <dt>Top right buttons</dt><dd>In order: noticeboard, ＋ New company, Edit map, language (globe), help (question mark) and airport (plane). While you pick a spot, only Cancel or Done stays.</dd>
          <dt>After disbanding or moving</dt><dd>Land grown only for that company turns back into sea. Land other companies or the airport still use stays.</dd>
          <dt>Edit map</dt><dd>Click a company to select it, then click a new spot to move it. The translucent green area is the land that would grow. Putting it back changes nothing, and clicking the same company again deselects it. The airport cannot move. Press Done or Esc to finish.</dd>
        </dl>
      </>
    ),
  },
  airport: {
    label: 'Airport',
    alt: 'The airport open: the airport on the map and its file on the right',
    body: (
      <>
        <p>The airport is the island's control center and holds what all companies share. Click the airport or its name tag on the map to open it, and the view moves there. The plane button at the top right opens it without moving the view. Click elsewhere on the map or press Esc to put it away. You can choose which tab opens first with Default airport tab in Settings.</p>
        <p>The airport stays where it is, and no company can be built on it. Planes land, taxi to a stand and take off again, and now and then others pass high overhead.</p>
        <dl>
          <dt>Model providers</dt><dd>Where employees' models come from.</dd>
          <dt>Blueprints</dt><dd>Templates for making employees.</dd>
          <dt>Workflows</dt><dd>The steps a task goes through.</dd>
          <dt>Settings</dt><dd>Preferences and settings files for the whole app.</dd>
          <dt>About</dt><dd>Links, thanks and the version number.</dd>
          <dt>Quit</dt><dd>In the Mac app, the power button beside the Airport title quits the app. If work is running it asks first, and open terminals end too. The web version has no such button.</dd>
        </dl>
      </>
    ),
  },
  company: {
    label: 'Company',
    alt: 'A company open: the cut-away office on the left and the Tasks tab of its file on the right',
    body: (
      <>
        <p>A company has one project folder and one target branch. The folder button after the project location opens it in Finder. Click the building, its plot or its name tag to open a company, and click elsewhere on the map or press Esc to put it away. On the right is the company file. On the left you can see employees in the office: those with work sit at their desks, and the rest walk around, chat with colleagues, sit on the sofa, have coffee or daydream. Every office has a coffee machine and a sofa.</p>
        <p>The building grows with the company: more finished tasks and employees mean more floors and a bigger footprint (up to 10×10 cells and 10 floors).</p>
        <p>The company file has Chats, Tasks, Employees, Terminal and Settings tabs. You can choose which one opens first with Default company tab in Airport → Settings.</p>
        <p>When something is not ready, a red stamp above the tabs says what is missing, and the matching add button is disabled:</p>
        <dl>
          <dt>Model provider</dt><dd>None, or unavailable: add one, sign in or refresh its models at the airport. Affects chats, tasks and employees.</dd>
          <dt>Employees</dt><dd>The company has none: add one first. Affects chats and tasks. If one employee's model stops working you only get a warning, and the others carry on.</dd>
          <dt>Project folder</dt><dd>Not found: put it back. Affects chats, tasks and the terminal.</dd>
          <dt>Git repo</dt><dd>The folder is not a git repo: run <code>git init</code> in the terminal. Affects tasks.</dd>
          <dt>Target branch</dt><dd>The branch is gone: change it in the company's Settings. Affects tasks.</dd>
        </dl>
      </>
    ),
  },
  provider: {
    label: 'Model providers',
    alt: "A model provider's details: connection, models and the employees using it",
    body: (
      <>
        <p>Model providers supply the models employees can use. Manage them in Airport → Model providers. The types are Anthropic, OpenAI, Google Gemini and OpenAI compatible (such as DeepSeek or a local Ollama).</p>
        <dl>
          <dt>API key</dt><dd>Enter an API key. The screen shows only the last four characters. The full key is kept in this computer's database, not in the settings files. OpenAI compatible also needs an API address.</dd>
          <dt>Subscription sign-in</dt><dd>Anthropic and OpenAI can sign in with a Claude or ChatGPT subscription instead of an API key. A Claude subscription works through Claude Code: if this computer does not have it, you are asked to agree to the install, then sign in in the browser. On the web, start the backend first (<code>make dev</code>).</dd>
        </dl>
        <p>Providers supply the models, so you do not type them. A provider cannot be deleted while employees use its models. Models that cannot read images may report an error when they receive one.</p>
      </>
    ),
  },
  blueprint: {
    label: 'Blueprints',
    alt: "A blueprint's details: source, prompt, skills and tools",
    body: (
      <>
        <p>A blueprint is a template for employees: a name, a prompt, skills and allowed tools. It has no model, because each employee picks their own. All companies share blueprints. Manage them in Airport → Blueprints, where the list is split into Mine and Built-in. The six built-in ones are Project Manager, Product Owner, Designer, Backend Engineer, Frontend Engineer and QA Engineer.</p>
        <p>Built-in blueprints are ready to use but cannot be changed or deleted. To change one, press Copy at the top right: it brings in the text in the language shown, for you to edit and save as your own. Built-in blueprints show in the app's language, but employees always receive the English version plus a rule about which language to reply in. Your own blueprints are given as you wrote them.</p>
        <dl>
          <dt>Add</dt><dd>Fill in the name, prompt, comment, skills and tools. Blueprints imported from GitHub earlier can still change their name, repo and version.</dd>
          <dt>Skills</dt><dd>These can come from local folders or several GitHub repos. Choose with Include only and Exclude. Each GitHub source shows its update state.</dd>
          <dt>Tools</dt><dd>There are only four: read files, write files, web search and run commands. Reading files also lets employees see PNG, JPEG, GIF and WebP images (up to 3.75MB each). Running commands has no sandbox, so allow it only for blueprints you trust.</dd>
        </dl>
        <p>A blueprint cannot be deleted while employees use it.</p>
      </>
    ),
  },
  flow: {
    label: 'Workflows',
    alt: 'Editing a workflow: a row of step notes with a small dot on each arrow, and Add step below',
    body: (
      <>
        <p>A workflow is the steps for doing the work, drawn left to right as notes and arrows. Every workflow starts with Clarify requirements and ends with Acceptance review (red notes, always done by the task owner).</p>
        <p>Each step in between either has an employee do the work (yellow, with a prompt) or discusses with an employee (green). Each step sets its assignment (first available or everyone), start condition and handoff. A step can branch to several next steps or wait for several previous ones. A dashed arrow means "pick one next step" or "start when any previous step is done".</p>
        <dl>
          <dt>Connect steps</dt><dd>While editing, drag a note onto another to connect them. Drag it to an empty part of the drawing to grow a new next step.</dd>
          <dt>Change arrows</dt><dd>Move the cursor to the small dot in the middle of an arrow: ＋ inserts a step there and × removes the arrow.</dd>
          <dt>When you cannot save</dt><dd>You cannot save with an unconnected or unnamed step. A workflow cannot loop back to an earlier step.</dd>
        </dl>
        <p>A workflow names no employees: each task decides who does the work. All companies share workflows. Manage them in Airport → Workflows, where the list is split into Mine and Built-in. You can add, edit, copy and delete your own. The built-in Feature development, Bug fix and Product planning cannot be changed or deleted, and a copy becomes your own in the language shown. Changing a workflow affects only tasks started later. A new task starts with the workflow this company last chose, or the first one.</p>
      </>
    ),
  },
  settings: {
    label: 'Settings',
    title: 'Airport settings',
    alt: "The airport's Settings tab: general, features, game objects and settings files",
    body: (
      <>
        <p>Changes here apply at once. Language is kept by the backend, and the other options only on this computer.</p>
        <dl>
          <dt>Language</dt><dd>Also on the globe button at the top right of the main screen. The language of the interface and of built-in blueprints and workflows, and the one employees reply in. The interface switches at once. Employees switch from their next reply, and old messages stay as they are.</dd>
          <dt>Default airport tab</dt><dd>Which tab the airport opens on. Model providers by default.</dd>
          <dt>Default company tab</dt><dd>Which tab a company opens on. Tasks by default.</dd>
          <dt>Task log order</dt><dd>Newest first or last, for task, sub-task and employee logs.</dd>
          <dt>Keep terminals</dt><dd>Off by default. When on, a terminal keeps running when you leave the company, is there when you return, and ends when the app closes.</dd>
          <dt>Game objects</dt><dd>Turn off details, shadows, people on the map, plane animation or clouds to make the screen run more smoothly.</dd>
          <dt>Settings files</dt><dd>Interface preferences (preferences.yaml), companies, employees, your own blueprints and workflows, and providers are stored as files under <code>~/.team-work</code>. Built-in ones are not there. After editing them yourself, press Reload settings. They apply only if the whole batch passes its checks; otherwise the current settings stay.</dd>
        </dl>
      </>
    ),
  },
  about: {
    label: 'About',
    alt: "The airport's About tab: links, thanks and version number",
    body: <p>The About tab has links, thanks and the current version number. Include the version when you report a problem.</p>,
  },
  chat: {
    label: 'Chats',
    alt: 'A chat with an employee: a pencil under your message for editing, then the message box and attach button',
    body: (
      <>
        <p>Without starting a task, you can discuss things with an employee or have them do simple work. A chat does not take up the employee's task slot. They work directly in the project folder, changes apply at once, and you are warned when the folder has uncommitted changes.</p>
        <dl>
          <dt>Start</dt><dd>Press ＋ New chat and pick an employee. The default is the employee from this company's last new chat. The model comes with the employee. The chat exists once you send the first message, and after that the employee and model cannot change.</dd>
          <dt>Replies</dt><dd>Replies appear word by word, and you can pause while they are being written. Enter sends, and Shift+Enter starts a new line.</dd>
          <dt>Attachments</dt><dd>Press the paper clip to pick images or files, or paste a screenshot. You can send attachments with no text, up to 3.75MB each and 6 per message in total. PNG, JPEG, GIF and WebP show previews; other files show a name you can press to download. Employees receive a text preview for text files; PDF, Office and other formats require available tools and may not be readable.</dd>
          <dt>Edit a message</dt><dd>Press the pencil under your message: it and everything after it disappear, and its text and attachments return to the box for you to change and resend. Pressing it during a reply also stops the reply. There is no undo, and files the employee changed are not restored.</dd>
          <dt>Create task</dt><dd>When you have discussed enough, press Create task. The employee writes the chat up as a new task for you to edit and start.</dd>
          <dt>Delete</dt><dd>Delete a chat at the top right. Changes in the folder stay. When an employee leaves the company, their chats stay readable, but you cannot post in them.</dd>
        </dl>
      </>
    ),
  },
  task: {
    label: 'Tasks',
    alt: "A task's details: the workflow drawing and each step's progress",
    body: (
      <>
        <p>A task is a piece of work you give the company, following one workflow. Each task has a task owner, who does Clarify requirements at the start and Acceptance review at the end.</p>
        <p>Each step of the workflow becomes a sub-task for the employees assigned to it. When done, they write a handoff for the next step. Progress in the details lists each sub-task's state, and opening one shows its log and the files handed off.</p>
        <p>Each task has its own branch, shown under the title in the details. Every step commits its work to this branch.</p>
        <p>You can attach images and files to a new task: press ＋ to pick them, or paste a screenshot in the text box. Each attachment can be up to 3.75MB, with 6 in total. The workflow list shows each workflow's name and drawing.</p>
        <p>For similar work, press Copy at the top right of a task's details. A new task opens with the title, description, attachments, workflow and staff filled in. Change what you need and press Start.</p>
        <dl>
          <dt>Four columns</dt><dd>Todo, Progressing, Wait for Review and Complete. A note with a red exclamation mark needs your reply, and a green merge icon is waiting for you to merge.</dd>
          <dt>Noticeboard</dt><dd>The noticeboard at the top right of the main screen lists every company's tasks, and you can add tasks there too. The red circle on its button counts all tasks waiting for review.</dd>
          <dt>Pause</dt><dd>Pause and continue at the top right of a task's details.</dd>
          <dt>Cost</dt><dd>Sub-tasks record their cost. When a task reaches the company's limit, it stops and asks you.</dd>
        </dl>
        <p>If the review does not pass, the work goes back to an earlier step to redo, at most twice per task. You can edit a task (title, description, owner and each step's employees; the workflow cannot change once started), pause it and delete it.</p>
      </>
    ),
  },
  reply: {
    label: 'Replies and discussions',
    alt: 'A discussion in a sub-task: messages between you and the employee, then the message box and End discussion button',
    body: (
      <>
        <p>When a decision is yours, the task moves to Wait for Review, and its note and that step in Progress get a badge. A red exclamation mark means reply, which you do inside the sub-task by opening that step. A green merge icon means the work is done and waiting for you to merge.</p>
        <dl>
          <dt>Answer a question</dt><dd>When an employee has a question, cannot pick the next step, runs out of retries or hits the cost limit, pick an option, write a reply and press Confirm.</dd>
          <dt>Discuss with an employee</dt><dd>At a green discussion step, the employee reads the earlier handoffs, then asks you. Replies appear word by word. Enter sends, Shift+Enter starts a new line, and you can go back and forth many times.</dd>
          <dt>End discussion</dt><dd>When it is settled, press End discussion and choose Continue to go to the next step, Send back to write what to change, or Stop task (which asks once more).</dd>
          <dt>Merge</dt><dd>After the review passes, press Merge on the Merge row to have the task owner merge the branch into the target branch, or press Send back to write what to change and have it redone.</dd>
        </dl>
      </>
    ),
  },
  crew: {
    label: 'Employees',
    alt: 'The Employees tab: grouped by blueprint, with model and thinking level under each name',
    body: (
      <>
        <p>Employees are the AI agents who work in a company. Each is made from a blueprint, then picks a model and thinking level . The model list is grouped by provider, and models no provider offers but an employee still uses are under Other. The model's provider decides the thinking levels; default leaves it to the provider. You can also roll the die for another look.</p>
        <p>In the list, each name has the model and thinking level under it, and while they work, the right side shows which step. In lists for picking people, the white notes are the tools they can use. An employee does one sub-task at a time, but chats do not take up their work.</p>
        <p>An employee's details have their work log and memory. Memory stays in this company for later work and leaves out task progress. Before dismissing an employee, pick someone to take over their tasks and steps. A company's only employee cannot be dismissed.</p>
      </>
    ),
  },
  terminal: {
    label: 'Terminal',
    alt: "The company file's Terminal tab: zsh on a black sticky note",
    body: (
      <>
        <p>A real zsh in the project folder. It loads your <code>~/.zshrc</code>, so you can run commands, use vim and press Ctrl+C. It starts the first time you open this tab.</p>
        <dl>
          <dt>When it ends</dt><dd>It keeps running while you switch tabs, and ends when you close the company file or change company.</dd>
          <dt>Keep terminals</dt><dd>With this on in Airport → Settings, it keeps running when you leave the company and is there when you return, until the app closes or the company is disbanded. On the web, a refresh counts as closing.</dd>
          <dt>Keyboard</dt><dd>Press F6 to leave the terminal. Focus returns to the tab.</dd>
        </dl>
      </>
    ),
  },
  teamset: {
    label: 'Settings',
    title: 'Company settings',
    alt: "The company file's Settings tab: name, target branch, AGENTS.md and run limits",
    body: (
      <>
        <p>The company file's Settings tab affects only this company.</p>
        <dl>
          <dt>Name</dt><dd>The company's name, also shown on its tag on the map.</dd>
          <dt>AGENTS.md</dt><dd>Shared instructions for every employee of this company, on top of the blueprint's prompt. It is the same file in the project folder, so edits on either side sync, but nothing is committed automatically.</dd>
          <dt>Target branch</dt><dd>The branch finished tasks merge into. The list is saved when the company is created, so branches made later do not appear.</dd>
          <dt>Sub-task timeout</dt><dd>How long one sub-task can run.</dd>
          <dt>Task cost limit</dt><dd>When a task's cost reaches this, it stops and asks you.</dd>
          <dt>Retries on failure</dt><dd>How many times a failed sub-task retries automatically before asking you.</dd>
          <dt>Disband company</dt><dd>Removes its employees and tasks, ends open terminals, and turns unused land back into sea. Blueprints stay. You can also delete the local files (off by default).</dd>
        </dl>
      </>
    ),
  },
}
