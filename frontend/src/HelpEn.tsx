// The help in English, topic by topic. Help.tsx has the same topics in Chinese, and a test keeps the two matched,
// laid out the same way: what it is for, the pitfall if there is one, then the reference in one <dl>.

import type { ReactNode } from 'react'

/** One topic in one language: its name in the list, its title when that is unclear, its screenshot's text and its body. */
export interface HelpTopic { label: string; title?: string; alt: string; body: ReactNode }

export const HELP_EN: Record<string, HelpTopic> = {
  start: {
    label: 'Quick start',
    alt: 'Two companies and the airport on the island; at the top right, the new company, edit map, language, help and settings (plane) buttons',
    body: (
      <>
        <p>Team Work treats each project as a company, in a building on the island. The company's employees are AI agents who follow a workflow step by step to finish the tasks you give them.</p>
        <ol>
          <li>In Airport → Model providers, connect at least one provider, so employees have models to use.</li>
          <li>Press ＋ New company, pick a spot on the map, then fill in the project folder, name and target branch.</li>
          <li>On the company's Employees tab, add employees: pick a blueprint and a model. The blueprints and workflows the official source brings are ready to use.</li>
          <li>For small things, just ask on the Chats tab. For bigger work, create a task on the Tasks tab: pick a workflow, then choose the task owner and the employees for each step.</li>
          <li>The task owner hands each step of the workflow to an employee. Opening the task opens the conversation with the owner, and anything waiting on you stays above the message box. When the work is done, press Merge to bring the changes back to your project.</li>
        </ol>
        <p className="fx-help-pit">In a chat, the employee changes your project folder directly. A task works in a separate copy instead: it cannot see changes you have not committed, and its work reaches your project only when merged.</p>
        <dl>
          <dt>Something missing</dt><dd>A red stamp above a company's tabs says what to do first; see Company.</dd>
          <dt>Put away</dt><dd>Press Esc or click an empty part of the map to put away an open company, the airport or the help.</dd>
          <dt>Language</dt><dd>Press the globe at the top right.</dd>
          <dt>Tutorial</dt><dd>The list beside the clock shows things to try next; click one to be taken where to do it.</dd>
        </dl>
      </>
    ),
  },
  map: {
    label: 'Map',
    alt: 'Editing the map: a dashed plot follows the cursor for the selected company',
    body: (
      <>
        <p>Each building on the island is a company, and you decide where it goes. Use ＋ New company to build one, and Edit map to move one elsewhere.</p>
        <dl>
          <dt>Move the view</dt><dd>Drag the map, or use WASD or the arrow keys (hold Shift to go faster). Scroll to zoom: in toward the cursor, out from the middle of the screen.</dd>
          <dt>Pick a spot</dt><dd>A dashed frame follows the cursor and can go on land or sea. The whole plot must fit within the current land expanded by 32 cells, without overlapping other companies or the airport; the frame turns red when it cannot, and clicking there shows why in the tip. A white grid over a light tint marks where plots can go, and the translucent green area is the land that would grow.</dd>
          <dt>Look</dt><dd>Once placed, you see a preview of the building. Its look is random, and the die picks another.</dd>
          <dt>Move a company</dt><dd>Press Edit map, click a company to select it, then click a new spot to move it; click the same company again to deselect it. Press Done or Esc to finish. The airport cannot move.</dd>
          <dt>Follow someone</dt><dd>Leave the main screen alone for a while, with no click, drag, scroll or key, and the camera picks someone at random and follows them: map people only by default. Set Idle camera follow target to All people to include employees in their offices (the building opens up and their name shows). Buildings in the way open up too. Click, drag, scroll or press any key to stop, and the view goes back to where it was; clicking a building, the airport or a button opens it straight away too. Each time it picks someone new. Choose how long it waits under Follow someone when idle in the settings (15 seconds to start with, or off); with People on the map off, Map people only does not follow anyone, while All people follows only employees.</dd>
          <dt>After disbanding or moving</dt><dd>Land grown only for that company turns back into sea. Land other companies or the airport still use stays.</dd>
        </dl>
      </>
    ),
  },
  tower: {
    label: 'Cell Tower',
    alt: 'The open cell tower: the paired computers with their Let it work this computer switches, then Pair a new computer',
    body: (
      <>
        <p>The cell tower pairs two computers that both run Team Work. Once paired, you can Go from this one to the other's island and work its companies, employees, tasks, chats and terminals directly. The work runs on that computer, with its model providers, blueprints and settings, and goes on when this one is closed.</p>
        <p className="fx-help-pit">The computer being worked must keep Team Work open: when it closes, nobody can reach it, and its own work stops too.</p>
        <dl>
          <dt>Pairing</dt><dd>Under Pair a new computer, the computer to be worked picks Let another work this one, presses Wait for pairing and copies the address; the other picks Work another, pastes the address and sends it. Pairing is done once the computer being worked presses Agree. The address lasts 10 minutes. After that, reopening the app or losing the connection never needs pairing again.</dd>
          <dt>Let it work this computer</dt><dd>Each paired computer has its own switch; only while it is on can that computer work this one. Right after pairing, only the computer being worked has it on; for the other way round, turn it on in your own tower. Turning it off or unpairing shuts the other computer out at once.</dd>
          <dt>Going and coming back</dt><dd>Go first checks that the other computer can be worked, then switches to its island. The lower left corner always says which computer you are working; press Back to my island to return. The cell tower on another island opens this computer's tower.</dd>
          <dt>On another island</dt><dd>Interface settings, the language and the tutorial stay this computer's. A new company browses the other computer's folders inside the page. Anything that would open a window on the other computer's screen (Open in Finder, Open settings folder, browser sign-in) is off.</dd>
          <dt>Versions</dt><dd>When the two computers' Team Work are not compatible, they cannot pair or go to each other, and the screen says which one to update.</dd>
        </dl>
      </>
    ),
  },
  airport: {
    label: 'Airport',
    alt: 'The airport open: the airport on the map and its file on the right',
    body: (
      <>
        <p>The airport holds what all companies share: chats, model providers, blueprints, workflows, sources, usage, terminal and settings, each with its own topic under Airport on the left. Click the airport or its name tag on the map to open it, and the view zooms in; the plane button at the top right opens it without moving the view.</p>
        <p className="fx-help-pit">Blueprints, workflows, sources and providers changed here affect every company.</p>
        <dl>
          <dt>Its place</dt><dd>The airport stays where it is, and no company can be built on it.</dd>
          <dt>Which tab opens</dt><dd>Set by Default airport page and Auto-switch default page in Settings.</dd>
        </dl>
      </>
    ),
  },
  company: {
    label: 'Company',
    alt: 'A company open: the cut-away office on the left and the Tasks tab of its file on the right',
    body: (
      <>
        <p>A company has one project folder and one target branch. Click the building, its plot or its name tag to open it: on the right is the company file, with Chats, Tasks, Employees, Files, Terminal and Settings tabs; on the left is the office, where those with work sit at their desks.</p>
        <p className="fx-help-pit">When something is missing, a red stamp shows above the tabs and the matching add button is disabled; do what the stamp says and it comes back.</p>
        <dl>
          <dt>Stamp: model provider</dt><dd>None, or unavailable: add one, sign in or refresh its models at the airport. Affects chats, tasks and employees.</dd>
          <dt>Stamp: employees</dt><dd>The company has none: add one first. Affects chats and tasks. If one employee's model stops working you only get a warning, and the others carry on.</dd>
          <dt>Stamp: project folder</dt><dd>Not found: put it back. Affects chats, tasks and the terminal.</dd>
          <dt>Stamp: git repo</dt><dd>The folder is not a git repo: run <code>git init</code> in the terminal. Affects tasks.</dd>
          <dt>Stamp: target branch</dt><dd>The branch is gone: change it in the company's Settings. Affects tasks.</dd>
          <dt>No git</dt><dd>While this Mac has no git, the whole app stops and greys out under a note. Press Install and install the developer tools in the window Apple opens; the app comes back once they are in.</dd>
          <dt>Company notes</dt><dd>The sticky note pinned to the upper right. Open it to read the notes as Markdown, and click them to edit; they save as you type. They are stored in <code>.team-work/NOTES.md</code> in the project folder, are not committed automatically, and are not given to employees.</dd>
          <dt>Change company</dt><dd>While one is open, other companies keep their name tags; click one to go straight there.</dd>
          <dt>Which tab opens</dt><dd>Set by Default company page and Auto-switch default page in Airport → Settings.</dd>
          <dt>Building</dt><dd>More employees mean a bigger footprint (up to 10×10 cells); a bigger project means more floors (up to 10); more finished tasks dress it up: a sign, flags, a billboard, neon, and at last an LED screen.</dd>
        </dl>
      </>
    ),
  },
  airchat: {
    label: 'Chats',
    title: 'Airport chats',
    alt: "The airport's Chats tab: a chat with the airport staff",
    body: (
      <>
        <p>Talk with the airport staff, with no employee to pick and no company involved. Use it to ask how the app works, or for work across companies: viewing, creating or changing tasks in any company, and managing blueprints, workflows and model providers.</p>
        <p className="fx-help-pit">The airport staff's commands can reach the whole computer, not just one project folder, and they create or change tasks without asking you first.</p>
        <dl>
          <dt>How it differs from a company chat</dt><dd>Type # to pick a file or folder from your home folder one level at a time, not from a project folder. You can change the model and thinking level in the chat, except during a reply. Everything else (attachments, queue, editing, handing over…) works as in a company's Chats.</dd>
          <dt>Blueprint</dt><dd>They work by the built-in Airport Staff blueprint, which gives their role, tools and skills; it cannot be used to add employees.</dd>
          <dt>Working folder</dt><dd>The airport folder in the data directory.</dd>
          <dt>Unread mark</dt><dd>Replies you have not seen and chats waiting for your answer show on the blue mark on the airport's name tag on the map.</dd>
        </dl>
      </>
    ),
  },
  provider: {
    label: 'Model providers',
    alt: "A model provider's details: connection, models and the employees using it",
    body: (
      <>
        <p>Model providers supply the models employees can use, and you need at least one before adding employees. The types are Anthropic, OpenAI, Google Gemini and OpenAI compatible (such as DeepSeek or a local Ollama), signed in with an API key or a subscription. Providers list their models, so you do not type them. The list is read again when the app starts, and in the background when you open a model list more than 8 hours after the last read; to see a new model at once, press Reload models at the top right of the provider's page.</p>
        <p className="fx-help-pit">If a subscription signs out elsewhere or expires, the provider goes back to signed out and replies fail: press Sign in again under the message, then Reply again once signed in.</p>
        <dl>
          <dt>API key</dt><dd>The screen shows only the last four characters. The full key is kept in this computer's database, not in the settings files. OpenAI compatible also needs a Base URL.</dd>
          <dt>Subscription sign-in</dt><dd>Anthropic and OpenAI can use a Claude or ChatGPT subscription instead of an API key. A Claude subscription works through Claude Code: if this computer does not have it, you are asked to agree to the install, then sign in in the browser. On the web, start the backend first (<code>make dev</code>).</dd>
          <dt>What is left</dt><dd>Under the clock at the top left of the main screen, each provider shows what is left. A subscription has two rings, 5 hours and weekly: the number is the percentage left, with the time until it resets below. Over half left is green, 20% to 50% yellow, and under 20% red. An API key shows its balance when it can be read, and is left out when it cannot.</dd>
          <dt>Images</dt><dd>Models that cannot read images may report an error when they receive one.</dd>
          <dt>Delete</dt><dd>A provider cannot be deleted while employees use its models.</dd>
        </dl>
      </>
    ),
  },
  blueprint: {
    label: 'Blueprints',
    alt: "A blueprint's details: source, prompt, skills and tools",
    body: (
      <>
        <p>A blueprint is a template for employees: a prompt, skills and allowed tools. It has no model, because each employee picks their own. All companies share blueprints. When unsure which to use, pick the official Generalist; to change an official or built-in one, press Copy at the top right and edit your own copy.</p>
        <p className="fx-help-pit">Run commands has no sandbox, so employees can reach the whole computer. Allow it only for blueprints you trust.</p>
        <dl>
          <dt>Official blueprints</dt><dd>Generalist, Frontend Engineer, Backend Engineer, Review &amp; QA, UI Design Engineer, Media Designer, Feature Planner, Researcher, Writer, DevOps Engineer, Matt Pocock and Poteto: 12 in all, from the official source, which cannot be changed or deleted. Matt Pocock and Poteto work by the skills their namesakes publish on GitHub. Official blueprints show in the app's language, but employees receive the English version plus a rule about which language to reply in. Your own blueprints are given as you wrote them.</dd>
          <dt>Built-in blueprint</dt><dd>Only Airport Staff, who work only in airport chats and cannot be hired.</dd>
          <dt>Blueprints from sources</dt><dd>A source can bring employee blueprints. The list is grouped by where they come from: yours, each source under its name, then built-in. Like built-in ones, blueprints from a source cannot be changed or deleted; copy one to change it, and the copy goes under yours.</dd>
          <dt>Skills</dt><dd>Every source in Airport → Sources is listed with its skills; click a skill to light it up and use it. Ticking a source's name uses all its skills, including ones added later, and a skill you dim is left out. With the name unticked, only the lit skills are used. If skills in use from two sources share a name, they turn red; dim one of them.</dd>
          <dt>Company folder skills</dt><dd>Whatever the blueprint, employees also read the skills in <code>.agents/</code>, <code>.team-work/</code>, <code>.codex/</code> and <code>.claude/</code> in the company's folder, and these win over a blueprint skill with the same name.</dd>
          <dt>Tools</dt><dd>Read files, write files, web search and run commands. Reading files also lets employees see PNG, JPEG, GIF and WebP images (up to 3.75MB each).</dd>
          <dt>Managing</dt><dd>Tools also decide whether an employee can manage tasks, blueprints, workflows and model providers. Read files lets them view these, write files or run commands also lets them add and change them, and web search alone allows neither. Official and built-in blueprints can all read and write.</dd>
          <dt>Hide</dt><dd>Point at a blueprint in the list and press the eye on the right to hide it, official ones too; the same button is at the top right of its page. A hidden blueprint is faded, cannot be picked when hiring and employees cannot see it; employees already on it work as before, and you can still edit it.</dd>
          <dt>Added or changed by employees</dt><dd>A blueprint an employee adds can be used at once. A change is written only if you agree, even when employees change their own. Once you agree, steps under way stay as they are, and later steps use the new blueprint. Built-in blueprints and those from Git or a source cannot be changed.</dd>
          <dt>Known limit</dt><dd>An employee who can run commands could still edit the settings files directly and reload them, without asking you.</dd>
          <dt>Older GitHub blueprints</dt><dd>Blueprints imported from GitHub earlier can still change their name, repo and version.</dd>
          <dt>Delete</dt><dd>A blueprint no one uses is deleted with two presses of the bin. While employees use it, you first see everyone on it in every company and pick another blueprint for all of them to move to; then it is deleted. Their names, looks, models and memories stay; work already running finishes as it was, and later work uses the new blueprint.</dd>
        </dl>
      </>
    ),
  },
  sources: {
    label: 'Sources',
    alt: "A source's details: version, what an update changes, and skills",
    body: (
      <>
        <p>A source is where skills, employee blueprints and task blueprints come from: a GitHub repo at a branch, or a folder on this computer. All blueprints and custom employees share them, and a blueprint picks the skills it uses from them. The employee and task blueprints a source brings are listed on their own tabs, under the source's name.</p>
        <p className="fx-help-pit">A newer version of a source is not used by default: open it and press Apply update, or turn on Apply updates automatically.</p>
        <dl>
          <dt>Add</dt><dd>Adding a GitHub source first reads its skills, employee blueprints and task blueprints, and it can be added only once something is found. A repo at a branch is downloaded only once.</dd>
          <dt>Employee and task blueprints</dt><dd>Put them in <code>blueprints/</code> and <code>workflows/</code> at the top of the source, one YAML file each, named with letters, digits, <code>-</code> and <code>_</code> only. An employee blueprint has <code>name</code>, <code>prompt</code>, <code>comment</code>, <code>tools</code> (<code>read_file</code>, <code>write_file</code>, <code>web_search</code>, <code>run_command</code>) and <code>skills</code>, and may have <code>look</code>. Each of its <code>skills</code> names a <code>repo</code> (with <code>ref</code> and <code>path</code> if needed), the full path of a folder on this computer, or a folder in the source, and picks with <code>include</code> and <code>exclude</code>. A task blueprint is written like the files in <code>~/.team-work/workflows/</code>, names no employees, and is laid out for you when it gives no positions. Files that cannot be read are listed under Could not be read on the source. <code>~/.team-work/</code> is the app's own folder, read for skills only.</dd>
          <dt>Several languages</dt><dd>An employee blueprint's <code>name</code>, <code>prompt</code> and <code>comment</code>, and the <code>name</code> and <code>prompt</code> of a workflow and of each step, can be one text, or one each for <code>en</code>, <code>zh</code>, <code>zh-Hans</code>, <code>ja</code> and <code>ko</code>. The app shows the language you picked, else English, else the first one written; employees get the English when there is one.</dd>
          <dt>Official source</dt><dd><code>yanun0323/Team-Work-Source</code> brings the official blueprints and workflows. Everyone has it, it cannot be removed, and it applies updates by itself by default. It downloads the first time you use the app, which needs the network; after that, the downloaded version works offline. If an employee's blueprint is gone (the source dropped it, its file was renamed, or you upgraded from an older version), they are marked Blueprint gone and listed first among employees. Steps they work stop and ask you; edit them and pick another blueprint to go on.</dd>
          <dt>Listed by themselves</dt><dd><code>~/.agents/</code>, <code>~/.team-work/</code>, <code>~/.codex/</code> and <code>~/.claude/</code> are listed as local sources. So are the GitHub repos the official blueprints read, such as <code>mattpocock/skills</code> for Matt Pocock, checked for updates like the ones you add.</dd>
          <dt>Check for updates</dt><dd>Sources are checked every hour; to check now, press the refresh button at the top right of a source. When a newer version is out, a red ! shows before the source in the list, and opening it lists the skills, employee blueprints and task blueprints added and removed, and the blueprints and employees affected. A folder has no versions: after changing its files, press Reload at the top right.</dd>
          <dt>When a blueprint is removed</dt><dd>If a newer version drops a blueprint employees are using, they switch to their own settings when it is applied, keeping what they had. They are listed under Switch to their own settings before you apply it.</dd>
          <dt>Skills</dt><dd>A source's page lists its skills by folder. Click a skill to open it on the next sheet, with what it is for, where its file is and its full text.</dd>
          <dt>Apply updates automatically</dt><dd>Off by default. When on, the source is stamped Auto-update, a newer version is used as soon as it is found, and a red dot shows before the source until you open it.</dd>
          <dt>Versions</dt><dd>Everyone using a source uses the same version. Work under way keeps the version it started with, and offline, the versions already downloaded still work.</dd>
          <dt>Delete</dt><dd>A source cannot be deleted while blueprints or employees use it, employees working by a blueprint it brings included. Its own blueprints do not count; they go with it.</dd>
        </dl>
      </>
    ),
  },
  flow: {
    label: 'Workflows',
    alt: 'Editing a workflow: a row of step notes with a small dot on each arrow, and Add step below',
    body: (
      <>
        <p>A workflow is the steps a task goes through, drawn left to right as notes and arrows: white steps are work for an employee, green ones are discussions with you. It names no employees; each task decides who does each step. All companies share workflows, and General task, Bug fix, Feature development and Code review from the official source are ready to use.</p>
        <p className="fx-help-pit">Changing a workflow affects only tasks started later; tasks already under way keep the old one.</p>
        <dl>
          <dt>Starts and ends</dt><dd>Every step with no arrow coming in is a start: they all begin when the task starts, each with the task description. Every step with no arrow going out is an end.</dd>
          <dt>Branching and waiting</dt><dd>A step can branch to several next steps or wait for several previous ones. A dashed arrow means "pick one next step" or "start when any previous step is done".</dd>
          <dt>Discussion steps</dt><dd>They have one employee, or several who hold a meeting, the first chairing.</dd>
          <dt>Edit a step</dt><dd>Click a note to open the step on a sheet above and change its name, kind, prompt, start condition, handoff and next steps. Press Done to close it; the workflow is kept only when you press Save.</dd>
          <dt>Connect steps</dt><dd>While editing, drag a note onto another to connect them, or to an empty part of the drawing to grow a new next step.</dd>
          <dt>Change arrows</dt><dd>Move the cursor to the small dot in the middle of an arrow: ＋ inserts a step there and × removes the arrow.</dd>
          <dt>Can send back</dt><dd>When it is on, a step that finds the step before it needs redoing can send the work back, at most twice per task. It is on for a new last step. It can be on only when the step has one step before it, which hands on to this step alone. Starts and discussions do not have it.</dd>
          <dt>When you cannot save</dt><dd>A step has no name, or an arrow loops back to an earlier step.</dd>
          <dt>Workflows from sources</dt><dd>Listed after yours, under each source's name, the official ones too. They cannot be changed or deleted; a copy becomes your own in the language shown.</dd>
          <dt>Hide</dt><dd>Workflows can be hidden like blueprints: they cannot be picked for a new task and employees cannot see them, while tasks already on them go on.</dd>
          <dt>On a new task</dt><dd>A new task starts with the workflow this company last chose, or the first one.</dd>
          <dt>Added or changed by employees</dt><dd>A workflow an employee with permission adds can be used at once, and a change is written only if you agree. Invalid content such as a loop, a workflow from a source, or one you edited after the employee read it are all refused.</dd>
        </dl>
      </>
    ),
  },
  stats: {
    label: 'Usage',
    alt: "The airport's Usage tab: totals, a bar for each day, and a list by provider and model",
    body: (
      <>
        <p>See how much the whole app has used models: tokens, cost and the trend day by day, then each provider and model. Use it to find the model that costs most, or the day usage jumped.</p>
        <p className="fx-help-pit">Cost counts only models with a price; subscriptions and models without one show a dash. Only usage since recording began is counted.</p>
        <dl>
          <dt>Period</dt><dd>The last 30 days or all time.</dd>
          <dt>Bars</dt><dd>One for each day, coloured by model. Point at one and the list below shows that day's numbers for the moment.</dd>
          <dt>Share</dt><dd>Each row's part of the list's total tokens, or of that day's while you point at a bar.</dd>
          <dt>Tokens</dt><dd>Leave out what was read back from the cache. Cache hit rate is the part of all input that was read back.</dd>
        </dl>
      </>
    ),
  },
  airterminal: {
    label: 'Terminal',
    title: 'Airport terminal',
    alt: "The airport's Terminal tab: zsh in the home folder",
    body: (
      <>
        <p>A real zsh in your home folder, belonging to no company: for things outside any project, such as signing in to a command-line tool or installing software. It starts the first time you open this tab.</p>
        <p className="fx-help-pit">By default the terminal ends when you close the airport, stopping whatever was running; tick Keep terminals in Settings to keep it.</p>
        <dl>
          <dt>Employees reading it</dt><dd>In airport chats, the airport staff can read the last 5,000 lines this terminal has shown, but cannot type into it. Company chats read their own company's terminal.</dd>
          <dt>Everything else</dt><dd>The keyboard, when it ends and the terminal startup command work as in a company's Terminal.</dd>
        </dl>
      </>
    ),
  },
  settings: {
    label: 'Settings',
    title: 'Airport settings',
    alt: "The airport's Settings tab: general, controls, features and game objects",
    body: (
      <>
        <p>Preferences for the whole app, applied at once. Language is kept by the backend, and the other options only on this computer.</p>
        <p className="fx-help-pit">After editing the settings files in <code>~/.team-work</code> outside the app, press Reload settings for them to apply.</p>
        <dl>
          <dt>Language</dt><dd>The language of the interface and of official and built-in blueprints and workflows, and the one employees reply in. Employees switch from their next reply, and old messages stay as they are.</dd>
          <dt>Default pages</dt><dd>Which tab the airport and a company open on: Model providers and Tasks by default.</dd>
          <dt>Auto-switch default page</dt><dd>Set to On: unread chats first by default. A task waiting for your reply opens Tasks, and a chat that is unread or waiting for your answer opens Chats; if both are waiting, the option decides. With nothing waiting, the default tab opens. The airport only looks at chats.</dd>
          <dt>Auto view</dt><dd>What the camera does when you click a company, the airport or a spot for a new company. Pan and zoom (the default) moves there, zooms in and locks the map. Pan only moves there: you can zoom but not pan. Off leaves the camera alone.</dd>
          <dt>Clicking the map</dt><dd>What a click on the map does while a company or the airport is open. Goes back to the main screen puts it away, detail sheets and all. Closes pages first (the default) puts away any open detail sheets first; click again to put away the company or airport.</dd>
          <dt>Task log order</dt><dd>Newest first or last, for task, sub-task and employee logs.</dd>
          <dt>Music and sounds</dt><dd>Music and effects have separate volumes, each with a mute beside its slider, and each kind of sound can be turned off or previewed on its own. Mute in background is on by default, so sound stops when you switch to another app. Notifications sound when a task waits for your reply or merge, or a chat gets a new reply; a chat you have open stays quiet. Sound starts after your first click or key press.</dd>
          <dt>System notifications</dt><dd>Mac app only, on by default. While the app is in the background, a task waiting for your reply or merge, or a chat with a new reply, shows a macOS notification; click it to open that task or chat. The number on the Dock icon is everything waiting. macOS asks once for permission; if you said no, turn it on in System Settings → Notifications.</dd>
          <dt>Keep terminals</dt><dd>Off by default. When on, a terminal keeps running when you leave the company or the airport, is there when you return, and ends when the app closes.</dd>
          <dt>Terminal startup command</dt><dd>Under Advanced. When filled in, each new terminal runs it as it starts.</dd>
          <dt>Game objects</dt><dd>Turn off details, shadows, people on the map, plane animation or clouds to make the screen run more smoothly. Time of day sets day and night: real time, Minecraft (a whole day in 20 minutes), always day or always night. Building at work picks what shows off both sides of a company's building while it works.</dd>
          <dt>Auto-name chats</dt><dd>Under System, off by default. When on, pick a model and thinking level: each new chat's first message is sent to that model to name it, and its usage counts toward that chat's tokens. Until it is named, the list shows the first message. Edit the name at the top of a chat directly; clearing it shows the first message again. A name you give is never replaced.</dd>
          <dt>Image generation</dt><dd>Under System, pick a ChatGPT subscription and every employee gets the <code>image_gen</code> tool to make or edit pictures, saved as PNG files in the working folder, or as GIFs of 2–16 frames for an animation. You can also tick Default image generation provider when adding or editing a ChatGPT subscription. Pick None to turn it off.</dd>
          <dt>Use Codex skills / Use Claude skills</dt><dd>Under System, both on by default. Turn one off and no blueprint reads the skills in <code>~/.codex/</code> or <code>~/.claude/</code> any more, though blueprints still list the folder. The same options cover <code>.codex/</code> and <code>.claude/</code> in a company's folder.</dd>
          <dt>Global employee rules</dt><dd>Under System. Every employee in every company receives them. They are stored in <code>~/.team-work/AGENTS.md</code>, and edits made outside the app apply from the next run or reply.</dd>
          <dt>Tutorial</dt><dd>The list beside the clock on the main screen shows 5 things at a time; finished ones are ticked and go, and ones the app can see you have done count as done. Skip tutorial hides the list, and Restart tutorial starts over.</dd>
          <dt>Settings files</dt><dd>Interface preferences, tutorial progress, companies, employees, your own blueprints and workflows, and providers are stored as files under <code>~/.team-work</code>; built-in ones and those from sources are not there. A reload applies only if the whole batch passes its checks; otherwise the current settings stay. Open settings folder shows this location in Finder.</dd>
          <dt>Reset to defaults</dt><dd>At the bottom of the page; press it twice. Every setting on the page returns to its default, including the language and the terminal startup command. The global employee rules are kept.</dd>
        </dl>
      </>
    ),
  },
  about: {
    label: 'About',
    alt: "The airport's About tab: links, license and version number",
    body: (
      <>
        <p>The About tab has links, the license, the version number and Report an issue. This topic also covers updating and quitting the app.</p>
        <dl>
          <dt>Report an issue</dt><dd>Opens a new GitHub issue with the version already filled in; paste images straight into the issue.</dd>
          <dt>Check for updates</dt><dd>The version shows under the time at the top left of the main screen. The Mac app checks at launch and then every hour; when a new version is out, a red ! appears right of the time. Press it to update, and downloading and installing go on in the window that opens. To check right away, press the version number, or use Check for Updates… in the menu. The web version has none of these buttons.</dd>
          <dt>Quit</dt><dd>In the Mac app, the power button beside the Airport title and Quit Team Work in the menu (⌘Q) both ask once first. Open terminals end with the app.</dd>
        </dl>
      </>
    ),
  },
  chat: {
    label: 'Chats',
    alt: 'A chat with an employee: a pencil under your message for editing, then the message box and attach button',
    body: (
      <>
        <p>Talk with an employee or have them do small work without starting a task: good for questions, small changes, or settling things before a task. You can also bring several employees together in a meeting.</p>
        <p className="fx-help-pit">In a chat, the employee works right in the project folder: changes apply at once, on no branch of their own, and you are warned when the folder has uncommitted changes. Editing or deleting messages does not undo files the employee changed.</p>
        <dl>
          <dt>Start</dt><dd>Press ＋ New chat and pick an employee; the default is the one from this company's last new chat. The model comes with the employee. The chat exists once you send the first message, and after that the employee and model cannot change.</dd>
          <dt>Meetings</dt><dd>Turn on Meeting in a new chat to pick two or more employees; the first one you pick chairs it. Mention someone not there with @ to ask them in, and they see the chat so far. A meeting holds up to 6. The largest name at the top is the chair's; press Change chair to hand it on. When the chair leaves the company, the next one takes over.</dd>
          <dt>Who replies</dt><dd>Those mentioned with @ reply in turn; @All has everyone reply, the chair last; with nobody mentioned, only the chair replies. The To line above the message box shows who will reply. Each one sees what the others said before them. Only one employee per round may create tasks, change blueprints or workflows, or ask you something: the one mentioned alone, or else the chair. Discussion steps in tasks follow the same rules.</dd>
          <dt>Keys</dt><dd>Enter sends, Shift+Enter starts a new line, and Tab and Shift+Tab indent and outdent. You can pause a reply.</dd>
          <dt>Queue and Steer</dt><dd>A message sent while the employee replies waits above the message box, marked Queue, and goes when the reply ends, in order. Press Steer to send it as soon as the employee's next tool call ends instead. The pencil takes it back to the box. After a pause or a failed reply, queued messages stay unsent until you press Steer.</dd>
          <dt>Skills and files</dt><dd>Type $ to pick from the skills of everyone in the chat, or # to pick a file or folder in the project. A $skill-name in a message hands that skill's instructions to the employee; in a meeting, everyone replying that round gets them. Once sent, the employees, files, folders and skills a message mentions can be opened. The Description field of a task also takes #.</dd>
          <dt>Questions</dt><dd>When an employee needs you to decide, they stop and ask. Pick an option or type your answer, and they carry on.</dd>
          <dt>Agree to a change</dt><dd>When an employee wants to change a blueprint or workflow, they stop and show the changes, before and after. Press Agree to write it or Refuse to leave it as it is, and the employee carries on either way. Sending a message instead counts as refusing.</dd>
          <dt>Attachments</dt><dd>Press the paper clip to pick images or files, or paste a screenshot. Each file can be up to 25MB, with 6 per message in total. Images over 3.75MB are shrunk automatically. Employees receive a text preview for text files; PDF, Office and other formats depend on the employee's tools and may not be readable.</dd>
          <dt>Copy a message</dt><dd>The copy button under a message copies its text.</dd>
          <dt>Edit a message</dt><dd>Press the pencil under your message: it and everything after it disappear, and its text and attachments return to the box to change and resend. Pressing it during a reply stops the reply. There is no undo.</dd>
          <dt>Drafts</dt><dd>Text and attachments not yet sent stay in the box when you close the chat, ready when you come back; they are gone once the app closes.</dd>
          <dt>Hand off to…</dt><dd>Press the branch icon under a message and pick an employee to copy the chat up to there into a new chat; the original stays as it is, and the new one takes its place on screen. Pick the same employee for a plain copy, or someone else to have them take over, knowing the earlier replies were not theirs. The new chat keeps the name with "Handoff: " in front, not the pin, goes to the top of the list, and waits for you to say something; the dashed line in it says which chat ID it was handed off from and to whom, and pressing it opens the original chat on top. A chat whose employee has left can be handed on the same way. A meeting handed to anyone, its chair too, becomes a one-on-one chat with them. An airport chat is only copied, to the airport staff.</dd>
          <dt>Create task</dt><dd>Press Create task and the employee writes the chat up as a new task for you to edit and create. Employees with permission can also create or change tasks themselves, which applies at once. A task created in a chat, and a blueprint, workflow or provider an employee creates there, is pinned under the message it was made at; click it to open it.</dd>
          <dt>List and name tags</dt><dd>While an employee replies, three dots bounce on the list, and a reply you have not seen shows a round dot. On the map, a company's name tag counts chats waiting for you (unread, or waiting for your answer) in blue and tasks waiting for review in red; the grey ring spinning before its name counts chats being replied to and tasks under way.</dd>
          <dt>Long chats</dt><dd>When a chat gets too long, the employee sums up the earlier part and carries on, and a divider reading "Earlier messages summed up" appears. All messages are kept. The screen loads the latest 100; Show earlier messages loads 100 more at a time. Browser search and selection cover only displayed messages. The employee reads only the summary from then on. The tokens used for this count toward the chat. The numbers under the box are about how much the next call sends, and the most the model can read. Set the limit for Google and compatible APIs on the provider; left empty it counts as 128K, and setting it too high lets a chat fail before it is summed up. How full a chat may get before it is summed up is set by the size of the limit under Auto compact in the airport's Settings, and 20K always stays free for the next reply. A meeting is summed up as soon as anyone in it reaches their point, with the chair's model writing the summary.</dd>
          <dt>Pin</dt><dd>Press the pin at the top right of a chat or on its row to keep it at the top of the list; press it again to unpin.</dd>
          <dt>Delete</dt><dd>Delete a chat at the top right; changes in the folder stay. When an employee leaves the company, their chats stay readable, but you cannot post in them.</dd>
        </dl>
      </>
    ),
  },
  task: {
    label: 'Tasks',
    alt: "A task's details: the workflow drawing and each step's progress",
    body: (
      <>
        <p>A task is a piece of work you give the company: its owner hands each step of a workflow to an employee, takes in what comes back and decides what comes next, and when it is done the task waits for you to merge. Use a task for bigger work, work split among several people, or work that should not touch the files you have open; for small things, a chat is enough.</p>
        <p className="fx-help-pit">When a task starts, it works in a separate copy of the project made from the target branch's latest commit. Changes in your project folder that are not committed are not there; commit them first if the task needs them.</p>
        <dl>
          <dt>Owner and steps</dt><dd>The task owner runs the whole task: it gives each step to an employee with instructions as planned, takes in each handoff before deciding what comes next, reports in the task's conversation, and merges the branch. A task with no owner cannot start. Who works each step is picked on the task, and employees on different models can work together; Apply to all steps has the owner alone do every step.</dd>
          <dt>Task conversation</dt><dd>Opening a task opens the conversation with its owner. What you write goes to the owner alone: change direction or ask for a meeting at any time. Handoffs, questions and what is said in meetings show under each employee's name; press the tag to open the step. Dispatches, pauses, send-backs and plan changes are short lines, and tool logs stay in the steps. Under each message you send it says Received, In progress or Done, and one that did not get through can be sent again. Ask the owner to put work outside the task into a task of its own: the new task waits in To do, and its line in the conversation opens it.</dd>
          <dt>Waiting on you</dt><dd>Questions only you can answer stay above the message box, several at a time, each answered on its own; Original message goes back to where it was asked. Adding someone not on the task, raising the budget, changing settings and merging are yours to decide; the owner cannot answer for you.</dd>
          <dt>Send a step back</dt><dd>Open a step from the tags at the top and press Send this step back with the reason. Its record stays, a new run redoes it, and later steps that read it are marked To recheck; the task pauses, and the step is redone once you resume. Nothing is deleted or rolled back.</dd>
          <dt>Older tasks</dt><dd>Tasks created before this version finish the way they started, marked Older flow, with no owner conversation; copy one to run it the new way.</dd>
          <dt>Sub-tasks and handoffs</dt><dd>Each step becomes a sub-task; when done, its employee writes a handoff for the next step. Progress lists each sub-task's state, and opening one shows its log and the files handed off; a file the step changed can be compared with how it was before the step, unified or split.</dd>
          <dt>Branch</dt><dd>Each task has its own branch, shown under the title. Every step commits its work to it.</dd>
          <dt>Four columns</dt><dd>Todo, Progressing, Wait for Review and Complete. A red exclamation mark needs your reply and a green merge icon waits for you to merge; see Replies and discussions.</dd>
          <dt>Start and pause</dt><dd>A new task waits in To do until you press Start at the top right of its details; then the owner starts handing out steps. The same button pauses and continues it. A pause first stops new steps from being handed out and stops the ones under way, and the task cannot continue until they have stopped; while paused you can still talk with the owner, and nothing starts again by itself. Stopping does not undo changed files or anything already done outside.</dd>
          <dt>Attachments</dt><dd>Press ＋ to pick them, or paste a screenshot in the text box. Each file can be up to 25MB, with 6 in total. Images over 3.75MB are shrunk automatically.</dd>
          <dt>Custom flow</dt><dd>Switch Flow to Custom to write this task's flow on the form: start from a blank step, or import a workflow and change it, editing as you would a workflow. A custom flow belongs to this task alone; press Save as workflow to reuse it.</dd>
          <dt>Copy a task</dt><dd>Press Copy at the top right of a task's details to open a new task with the title, description, attachments, workflow and staff filled in.</dd>
          <dt>Tasks from employees</dt><dd>Employees with permission can create tasks, which also wait in To do until you start them; the details show who created it. Employees can create and change tasks only in their own company, and the airport staff can reach every company. Tasks can be created at most 3 levels in a row.</dd>
          <dt>Task changes by employees</dt><dd>Employees can change the title, description, owner and each step's employees, applied at once. Work under way is not affected, and later steps see the new content.</dd>
          <dt>Cost and tokens</dt><dd>Sub-tasks record their cost, and a task that reaches the company's limit stops and asks you. Tokens leave out cache reads, and subscriptions are counted too; the cost limit ignores tokens.</dd>
          <dt>Done</dt><dd>Once the owner has checked that every step is done and nothing is left open, it reports the task done, and the task waits for you to merge. Steps a conditional branch did not pick are not done.</dd>
          <dt>Edit and delete</dt><dd>You can change the title, description, owner and each step's employees; the workflow cannot be swapped for another once started. A task waiting, under way or waiting for you to merge can also have its flow changed, written as a custom flow is: steps that already ran are faded and can be changed but not deleted, a step under way finishes as it was told, and work given out after that follows the new flow. A task whose flow you changed no longer follows its workflow: its flow is named "(custom)", and copying the task takes the changed flow. Changing the flow while it waits for you to merge takes it back to work, for the owner to confirm again. If the owner changed the plan after you opened the edit sheet, saving is turned down and what you wrote stays; close the sheet and open it again. When you change who works a step already under way, "Save, from the next step on" lets the one on it finish, and "Save and swap now" hands it to the new employee at once, who goes on from where it stopped. A step sent back is redone by whoever works it at that time.</dd>
        </dl>
      </>
    ),
  },
  reply: {
    label: 'Replies and discussions',
    alt: 'A discussion in a sub-task: messages between you and the employee, then the message box and End discussion button',
    body: (
      <>
        <p>When a decision is yours, the task moves to Wait for Review: a red exclamation mark means reply, and a green merge icon means the work is done and waiting for you to merge. Open the task and answer under Waiting on you, above the message box; on an older task, open the step with the badge in Progress.</p>
        <p className="fx-help-pit">Merging updates the target branch in your project folder; if it has changes that are not committed, the merge fails. Sort them out and press Merge again.</p>
        <dl>
          <dt>Answer a question</dt><dd>When an employee has a question, cannot pick the next step, runs out of retries or hits the cost limit, pick an option, write a reply and press Confirm.</dd>
          <dt>Agree to a change</dt><dd>When an employee wants to change a blueprint or workflow, that step lists the changes, before and after. Pick Agree or Refuse, optionally write a reply, and press Confirm.</dd>
          <dt>Meeting</dt><dd>At a green discussion step, the employee reads the earlier handoffs, then asks you, and you can go back and forth many times. With several employees it is a meeting, and who replies works as in Chats.</dd>
          <dt>End discussion</dt><dd>When it is settled, press End discussion and choose Continue to go to the next step, Send back to write what to change, or Stop task.</dd>
          <dt>Merge</dt><dd>Press Merge to have the task owner merge the branch into the target branch, resolving any conflicts first; to change something, tell the owner. On an older task you can also press Send back to write what to change and have it redone. You can also ask the owner in the conversation to merge: they give you a card, and merging starts when you press Merge on it.</dd>
        </dl>
      </>
    ),
  },
  crew: {
    label: 'Employees',
    alt: 'The Employees tab: grouped by blueprint, with model and thinking level under each name',
    body: (
      <>
        <p>Employees are the AI agents who work in a company. Each is made from a blueprint, then picks a model and thinking level. An employee can work on several sub-tasks and chats at once.</p>
        <p className="fx-help-pit">The more they do at once, the faster cost and subscription limits are used up.</p>
        <dl>
          <dt>Model and thinking level</dt><dd>The model list is grouped by provider, and models no provider offers but an employee still uses are under Other. The provider decides the thinking levels; default leaves it to the provider.</dd>
          <dt>Custom</dt><dd>Set Settings to Custom, then import from a blueprint and change it; it no longer follows the blueprint. None clears it. Custom settings belong to that employee alone, are deleted when they are dismissed, and come first in the list, under Custom.</dd>
          <dt>List</dt><dd>Each name has the model and thinking level under it; while they work, the right side shows which step, and +N counts the others under way. In lists for picking people, the white notes are the tools they can use.</dd>
          <dt>Memory</dt><dd>An employee's details have their work log and memory. Memory stays in this company and leaves out task progress. Employees add and remove notes themselves, and you can edit or delete them.</dd>
          <dt>Dismiss</dt><dd>First pick someone to take over their tasks and steps. A company's only employee cannot be dismissed.</dd>
        </dl>
      </>
    ),
  },
  files: {
    label: 'Files',
    alt: "The company file's Files tab: the project folder's tree",
    body: (
      <>
        <p>Browse the company's project folder to read a file, look at a picture or change a few lines without leaving the app. You can view and edit existing files, but not create, delete, move or rename anything.</p>
        <p className="fx-help-pit">If an employee, the terminal or another editor changed a file after you opened it, saving is refused, so their change is not overwritten. Copy out your changes, then press Reload.</p>
        <dl>
          <dt>The tree</dt><dd>A folder is read only when you open it, so hidden files, <code>.git</code> and <code>node_modules</code> are all there; what <code>.gitignore</code> leaves out is shown faded. Hover over a folder for a button at its right end that opens it in Finder. Open folders are read again when you come back to the tab or the app.</dd>
          <dt>Opening</dt><dd>Markdown is formatted, code is coloured, and PNG, JPG, GIF and WebP show as pictures. SVG shows as a picture too, and as its source when you edit it. Other files, and text files over 1 MiB, show why they cannot be previewed; you can show them in Finder.</dd>
          <dt>Editing</dt><dd>Press Edit at the top right of a text file. Code is coloured as you type; Markdown uses a plain text box. Save saves and puts it away; Command+S (Ctrl+S) saves and keeps editing. Files with CRLF line endings are saved with CRLF.</dd>
          <dt>Drafts</dt><dd>Put it away unsaved and the draft stays, marked by a red dot in the tree; press Edit again to carry on, or Discard changes to drop it. Drafts last until the app closes. Closing the company file or going to another company asks first when there are unsaved changes.</dd>
        </dl>
      </>
    ),
  },
  terminal: {
    label: 'Terminal',
    alt: "The company file's Terminal tab: zsh on a black sticky note",
    body: (
      <>
        <p>A real zsh in the project folder. It loads your <code>~/.zshrc</code>, so you can run commands, use vim and press Ctrl+C. It starts the first time you open this tab.</p>
        <p className="fx-help-pit">By default the terminal ends when you close the company file or change company, stopping whatever was running; tick Keep terminals in Airport → Settings to keep it.</p>
        <dl>
          <dt>When it ends</dt><dd>It keeps running while you switch tabs. With Keep terminals on, it runs until the app closes or the company is disbanded; on the web, a refresh counts as closing.</dd>
          <dt>Employees reading it</dt><dd>In company chats, employees whose blueprint has Read files or Run commands can read the last 5,000 lines the terminal has shown, but cannot type into it. Full-screen programs such as vim are left out. A reopened terminal starts a new record.</dd>
          <dt>Keyboard</dt><dd>Typing brings the keyboard back to the terminal from elsewhere, unless you are typing in another field; press F6 to leave it. Option works as Alt. Option+←→ moves by word, Command+←→ goes to the start or end of the line, Command+Delete deletes to the start of the line, Shift+Enter adds a line without running it, Command+K clears the screen, and Command+↑↓ scrolls to the top or bottom.</dd>
        </dl>
      </>
    ),
  },
  teamset: {
    label: 'Settings',
    title: 'Company settings',
    alt: "The company file's Settings tab: name, target branch, company employee rules and run limits",
    body: (
      <>
        <p>This company's own rules and limits: shared instructions for its employees, the branch tasks merge into, and how long a sub-task may run or how much it may spend before stopping to ask you.</p>
        <p className="fx-help-pit">Company employee rules are the AGENTS.md file in the project folder: edits on either side sync, but nothing is committed automatically.</p>
        <dl>
          <dt>Company employee rules</dt><dd>Shared instructions for every employee of this company, on top of the blueprint's prompt.</dd>
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
