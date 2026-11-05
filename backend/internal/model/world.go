// Package model holds the domain types. Names follow CONTEXT.md; JSON matches the frontend's types.ts.
package model

import (
	"encoding/json"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model/enum"
)

type Look struct {
	Skin  string `json:"skin"`
	Hair  string `json:"hair"`
	Shirt string `json:"shirt"`
	Pants string `json:"pants"`
	Extra string `json:"extra"`
	Style *int   `json:"style,omitempty"`
}

// BlueprintSource is a Git repo pinned to a commit, or a blueprint written by hand as YAML.
type BlueprintSource struct {
	Kind      string        `json:"kind"` // git, yaml, or local (skill packs only)
	Repo      string        `json:"repo,omitempty"`
	Ref       string        `json:"ref,omitempty"`
	Commit    string        `json:"commit,omitempty"`
	LatestRef string        `json:"latestRef,omitempty"`
	Latest    string        `json:"latest,omitempty"`
	Private   bool          `json:"private,omitempty"`
	Upstream  bool          `json:"upstream,omitempty"`
	Update    *SourceUpdate `json:"update,omitempty"`
	Text      string        `json:"text,omitempty"`
	Path      string        `json:"path,omitempty"`
}

type SourceUpdate struct {
	At    float64 `json:"at"`
	OK    bool    `json:"ok"`
	Error string  `json:"error,omitempty"`
}

// Source is a place items are read from, kept once for everything that uses it: a Git repo at a branch, or a folder
// on this computer. All of its users read the version in Commit; Latest is the newest one found upstream, and moving
// Commit to it is the user's call, or the source's own when AutoApply is set.
type Source struct {
	ID        string        `json:"id"`
	Kind      string        `json:"kind"` // git or local
	Repo      string        `json:"repo,omitempty"`
	Ref       string        `json:"ref,omitempty"`
	Path      string        `json:"path,omitempty"` // local: the folder
	Commit    string        `json:"commit,omitempty"`
	Latest    string        `json:"latest,omitempty"`
	Upstream  bool          `json:"upstream"`
	Update    *SourceUpdate `json:"update,omitempty"`
	AutoApply bool          `json:"autoApply"`
	// Unseen is set when an update was applied by itself, until the user opens the source.
	Unseen bool `json:"unseen,omitempty"`
}

// SkillPack is skills a blueprint takes from one place: the folder Path of the source SourceID ("" the whole source), a
// nil Include every skill there, so ones added later come too. Source is a place written into the pack itself, as
// built-in blueprints and those from before sources were kept apart have; with neither, it is the blueprint's own repo.
type SkillPack struct {
	SourceID string           `json:"sourceId,omitempty"`
	Path     string           `json:"path,omitempty"`
	Source   *BlueprintSource `json:"source,omitempty"`
	Include  []string         `json:"include"`
	Exclude  []string         `json:"exclude"`
}

type Blueprint struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Source  BlueprintSource `json:"source"`
	Prompt  string          `json:"prompt"`
	Comment string          `json:"comment"`
	Skills  []SkillPack     `json:"skills"`
	Tools   []enum.Tool     `json:"tools"`
	Look    Look            `json:"look"`
	// Owner is the employee whose own settings these are, made on their sheet rather than picked from the list;
	// empty for a blueprint anyone can be hired from. From is the blueprint they were copied from, if any.
	Owner string `json:"owner,omitempty"`
	From  string `json:"from,omitempty"`
}

type MemoryEntry struct {
	ID     string  `json:"id"`
	Text   string  `json:"text"`
	Source string  `json:"source"` // work, chat, retro, review or user
	At     float64 `json:"at"`
	TaskID string  `json:"taskId,omitempty"`
}

type Replica struct {
	ID          string        `json:"id"`
	TeamID      string        `json:"teamId"`
	BlueprintID string        `json:"blueprintId"`
	Name        string        `json:"name"`
	Look        Look          `json:"look"`
	Model       string        `json:"model"`
	Effort      string        `json:"effort"`
	Memory      []MemoryEntry `json:"memory"`
	HiredAt     float64       `json:"hiredAt"`
}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type WorkflowNode struct {
	ID     string        `json:"id"`
	Kind   enum.NodeKind `json:"kind"`
	Name   string        `json:"name"`
	Prompt string        `json:"prompt"`
	// ReplicaIDs are who work the step: one on a work step; on a discussion one, or several who hold it as a meeting,
	// the first chairing.
	ReplicaIDs []string `json:"replicaIds"`
	// Assignment is from before a work step had one employee, read so older settings still load; settleStaff drops it.
	Assignment string           `json:"assignment,omitempty"`
	Handoff    enum.HandoffMode `json:"handoff"`
	Join       enum.JoinMode    `json:"join"`
	// SendBack lets the step send work back to the one before it. Nil in flows from before it existed, which keep
	// the old rule: only the last step, and a step that was itself sent back, may.
	SendBack *bool `json:"sendBack,omitempty"`
	Pos      Point `json:"pos"`
}

type WorkflowEdge struct {
	ID        string `json:"id"`
	From      string `json:"from"`
	To        string `json:"to"`
	Condition string `json:"condition"`
}

type Workflow struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Nodes []WorkflowNode `json:"nodes"`
	Edges []WorkflowEdge `json:"edges"`
}

type TeamSettings struct {
	TimeoutMin   float64 `json:"timeoutMin"`
	CostLimitUSD float64 `json:"costLimitUsd"`
	Retries      int     `json:"retries"`
}

type Team struct {
	Plot           *Plot        `json:"plot,omitempty"`
	ID             string       `json:"id"`
	Name           string       `json:"name"`
	Folder         string       `json:"folder"`
	TargetBranch   string       `json:"targetBranch"`
	Branches       []string     `json:"branches"`
	InitializedGit bool         `json:"initializedGit"`
	Prompt         string       `json:"prompt"`
	Settings       TeamSettings `json:"settings"`
	CreatedAt      float64      `json:"createdAt"`
}

type NextStep struct {
	NodeID string `json:"nodeId"`
	Reason string `json:"reason"`
}

type AgentHandoff struct {
	Goal      string    `json:"goal"`
	Done      []string  `json:"done"`
	Outputs   []string  `json:"outputs"`
	Decisions []string  `json:"decisions"`
	Open      []string  `json:"open"`
	Next      *NextStep `json:"next,omitempty"`
}

type HumanSummary struct {
	Headline string   `json:"headline"`
	Did      []string `json:"did"`
	Outputs  []string `json:"outputs"`
	Ask      string   `json:"ask,omitempty"`
}

type Handoff struct {
	Agent  AgentHandoff `json:"agent"`
	Human  HumanSummary `json:"human"`
	Commit string       `json:"commit"`
}

type ReviewOption struct {
	ID     string `json:"id"`
	Label  string `json:"label,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type Review struct {
	Kind    enum.ReviewKind `json:"kind"`
	From    enum.Status     `json:"from"`
	Prompt  string          `json:"prompt,omitempty"`
	Reason  string          `json:"reason,omitempty"` // timeout or error
	Options []ReviewOption  `json:"options"`
	At      float64         `json:"at"`
	// Change is what a ReviewChange would write.
	Change *PendingChange `json:"change,omitempty"`
}

// PendingChange is a change to a blueprint, flow or model provider that an employee asked for, written only once the
// user agrees. Version is what the target's version was when asked; a target that has moved on since is not overwritten.
type PendingChange struct {
	Kind      string         `json:"kind"` // blueprint, workflow or provider
	TargetID  string         `json:"targetId"`
	Name      string         `json:"name"`
	Version   string         `json:"version"`
	Lines     []ChangeLine   `json:"lines"`
	Blueprint *Blueprint     `json:"blueprint,omitempty"`
	Workflow  *Workflow      `json:"workflow,omitempty"`
	Provider  *ModelProvider `json:"provider,omitempty"`
	// KeyRef names a new API key for Provider. The key is held in memory only, never saved or sent to clients.
	KeyRef string `json:"keyRef,omitempty"`
}

// ChangeLine is one difference, for the user to read. Field says what changed: name, prompt, comment, tools, skills,
// or for a flow's step (named by Node) also kind, staff, assignment, handoff, join; node and edge are a whole step or
// connection added or removed, and condition a connection's. A provider's are name, baseUrl, apiKey, prices and models.
type ChangeLine struct {
	Field  string `json:"field"`
	Node   string `json:"node,omitempty"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

type LogLine struct {
	At   float64        `json:"at"`
	Kind enum.LogKind   `json:"kind"`
	Text string         `json:"text"`
	Key  string         `json:"key,omitempty"`
	Args map[string]any `json:"args,omitempty"`
}

type ChatMessage struct {
	At   float64 `json:"at"`
	From string  `json:"from"` // user, agent, or tool (in a chat: what the employee ran)
	Text string  `json:"text"`
	// Images are what the user attached, in a chat.
	Images []Attachment `json:"images,omitempty"`
	Files  []Attachment `json:"files,omitempty"`
	// By is the employee who said or ran it, in a chat; empty in older chats, where it is the one the chat was with.
	By string `json:"by,omitempty"`
	// Mentions are the employees the user's message is for, in a meeting; none is the chair alone.
	Mentions []string `json:"mentions,omitempty"`
	// Failed marks a reply that did not come, in a chat; SignedOut is the provider to sign in to again, when that is why.
	Failed    bool   `json:"failed,omitempty"`
	SignedOut string `json:"signedOut,omitempty"`
	// Tasks are the ones made in the chat at this message, by the user or with create_task, oldest first.
	Tasks []string `json:"tasks,omitempty"`
}

// ChatGuest is someone in a meeting besides the chair. Name and Look keep who it was, for when they have left.
type ChatGuest struct {
	ReplicaID string `json:"replicaId"`
	Name      string `json:"name"`
	Look      Look   `json:"look"`
	Model     string `json:"model"`
}

// ChatHandoff is where an employee handed the chat to whoever comes next: the messages before Before were theirs
// to answer, back to the handoff before it.
type ChatHandoff struct {
	Before    int    `json:"before"`
	ReplicaID string `json:"replicaId"`
	Name      string `json:"name"`
}

// ChatJoin is where an employee joined the chat, invited or mentioned: before the message at Before. It is only
// shown to the user and never reaches a model.
type ChatJoin struct {
	Before    int    `json:"before"`
	ReplicaID string `json:"replicaId"`
	Name      string `json:"name"`
}

type Talk struct {
	Messages []ChatMessage `json:"messages"`
	// ReplyAt is set while the employee writes a reply: when they started.
	ReplyAt *float64 `json:"replyAt,omitempty"`
	// Speaker is who replies, or last replied; Next are who reply after them, in a discussion held by several.
	Speaker string   `json:"speaker,omitempty"`
	Next    []string `json:"next,omitempty"`
	Ended   string   `json:"ended,omitempty"`
}

// Chat is the user talking with an employee outside any task. With guests it is a meeting, which the employee chairs.
// Each one's model never changes. Name and Look keep who it was, for when the employee has left.
// A chat with no TeamID is the airport's: it is with the airport staff, and its model and Effort can change between replies.
type Chat struct {
	ID        string `json:"id"`
	TeamID    string `json:"teamId"`
	ReplicaID string `json:"replicaId"`
	Name      string `json:"name"`
	// Title names the chat in lists; empty shows its first message. The user can rename it, or a model names it from the first message.
	Title string `json:"title,omitempty"`
	// PinnedAt is when the user pinned the chat to the top of its list; nil when it is not pinned.
	PinnedAt *float64      `json:"pinnedAt,omitempty"`
	Look     Look          `json:"look"`
	Model    string        `json:"model"`
	Effort   string        `json:"effort,omitempty"`
	Messages []ChatMessage `json:"messages"`
	Tokens   int           `json:"tokens"`
	// ReplyAt is set while the employee writes a reply: when they started.
	ReplyAt *float64 `json:"replyAt,omitempty"`
	// Question is set while the employee waits for the answer to what they asked with ask_user.
	Question *ChatQuestion `json:"question,omitempty"`
	// Change is set while the employee waits for the user to agree to a change to a blueprint or flow.
	Change *PendingChange `json:"change,omitempty"`
	// Unread is set when the employee said something the user has not opened the chat to see.
	Unread bool `json:"unread,omitempty"`
	// Compact stands in for the start of the conversation when asking the model. The conversation itself stays whole.
	Compact *ChatCompact `json:"compact,omitempty"`
	// Handoffs are where other employees handed the chat on, oldest first.
	Handoffs []ChatHandoff `json:"handoffs,omitempty"`
	// Guests are the others in a meeting, in the order they joined.
	Guests []ChatGuest `json:"guests,omitempty"`
	// Joins are where guests joined once the chat was under way, oldest first.
	Joins []ChatJoin `json:"joins,omitempty"`
	// Speaker is who replies, or last replied, to the user's last message; Next are who reply after them.
	Speaker string   `json:"speaker,omitempty"`
	Next    []string `json:"next,omitempty"`
	// Context is about how many tokens the next call sends: what the model last read and wrote, and what came since.
	// It tells when to compact and shows how full the chat is.
	Context int `json:"context,omitempty"`
	// Queue is what the user said while a reply was being written, in the order it goes: the steered first.
	Queue     []QueuedMessage `json:"queue,omitempty"`
	CreatedAt float64         `json:"createdAt"`
}

// QueuedMessage waits for the reply being written to end. A steered one goes as soon as a tool call ends instead.
type QueuedMessage struct {
	ID     string       `json:"id"`
	At     float64      `json:"at"`
	Text   string       `json:"text"`
	Images []Attachment `json:"images,omitempty"`
	Files  []Attachment `json:"files,omitempty"`
	Steer  bool         `json:"steer,omitempty"`
	// Mentions are who it is for, as with a message.
	Mentions []string `json:"mentions,omitempty"`
}

// AtAirport says whether the chat is the airport's rather than a company's.
func (c *Chat) AtAirport() bool { return c.TeamID == "" }

// ChatCompact is a summary of a conversation's messages before Upto.
type ChatCompact struct {
	Upto    int    `json:"upto"`
	Summary string `json:"summary"`
}

// ChatQuestion is what an open question offers to answer with; the words of the question are a message in the chat.
type ChatQuestion struct {
	Options []string `json:"options"`
}

// TalkEnd is how the user ended a discussion: continue (to To), back (with Reason), or stop.
type TalkEnd struct {
	Kind   string `json:"kind"`
	To     string `json:"to,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type SentBack struct {
	To     []string `json:"to"`
	Reason string   `json:"reason"`
}

type Rework struct {
	From   string `json:"from"`
	Reason string `json:"reason"`
}

type SubTask struct {
	ID          string      `json:"id"`
	TaskID      string      `json:"taskId"`
	NodeID      string      `json:"nodeId"`
	ParentID    *string     `json:"parentId"`
	UpstreamIDs []string    `json:"upstreamIds"`
	ReplicaID   *string     `json:"replicaId"`
	Status      enum.Status `json:"status"`
	Cancelled   bool        `json:"cancelled"`
	Progress    float64     `json:"progress"`
	CreatedAt   float64     `json:"createdAt"`
	StartedAt   *float64    `json:"startedAt,omitempty"`
	EndedAt     *float64    `json:"endedAt,omitempty"`
	Attempts    int         `json:"attempts"`
	CostUSD     float64     `json:"costUsd"`
	Tokens      int         `json:"tokens"`
	RoutedTo    []string    `json:"routedTo"`
	Routed      bool        `json:"routed"`
	ArrivedAt   float64     `json:"arrivedAt"`
	Skipped     bool        `json:"skipped,omitempty"`
	Waiting     bool        `json:"waiting"`
	Group       string      `json:"group,omitempty"`
	Round       int         `json:"round,omitempty"`
	SentBack    *SentBack   `json:"sentBack,omitempty"`
	Rework      *Rework     `json:"rework,omitempty"`
	Review      *Review     `json:"review,omitempty"`
	Talk        *Talk       `json:"talk,omitempty"`
	Handoff     *Handoff    `json:"handoff,omitempty"`
	Log         []LogLine   `json:"log"`
	// SendBackReason is set when this run asks to send the work back; routing acts on it.
	SendBackReason string `json:"sendBackReason,omitempty"`
	// Unpriced records that the cost limit was found not to apply to this run's model.
	Unpriced bool `json:"unpriced,omitempty"`
}

type Merge struct {
	ReplicaID *string   `json:"replicaId"`
	Conflict  bool      `json:"conflict"`
	StartedAt *float64  `json:"startedAt,omitempty"`
	EndsAt    *float64  `json:"endsAt,omitempty"`
	Log       []LogLine `json:"log"`
}

type Attachment struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type Task struct {
	ID            string         `json:"id"`
	TeamID        string         `json:"teamId"`
	Number        int            `json:"number"`
	Title         string         `json:"title"`
	Description   string         `json:"description"`
	Images        []Attachment   `json:"images"`
	Files         []Attachment   `json:"files,omitempty"`
	WorkflowID    string         `json:"workflowId"`
	OwnerID       *string        `json:"ownerId"`
	Workflow      Workflow       `json:"workflow"`
	CreatedAt     float64        `json:"createdAt"`
	DoneAt        *float64       `json:"doneAt,omitempty"`
	Stage         enum.TaskStage `json:"stage"`
	Merge         *Merge         `json:"merge,omitempty"`
	Paused        bool           `json:"paused"`
	PausedAt      *float64       `json:"pausedAt,omitempty"`
	PausedStatus  enum.Status    `json:"pausedStatus,omitempty"`
	Branch        string         `json:"branch"`
	BudgetBonus   float64        `json:"budgetBonus"`
	CostCarry     float64        `json:"costCarry"`
	TokensCarry   int            `json:"tokensCarry"`
	MergeConflict bool           `json:"mergeConflict"`
	// Origin is who made the task, when it was not the user. Older tasks have none.
	Origin *TaskOrigin `json:"origin,omitempty"`
}

// TaskOrigin says who made a task with create_task. Name keeps who it was, for when they are gone.
// Depth counts how many tasks led here through employees working on tasks: a chat's task is 0.
type TaskOrigin struct {
	Kind  string `json:"kind"` // employee (working on a task), chat (a company's) or airport (an airport chat)
	ID    string `json:"id"`   // the employee's or the chat's
	Name  string `json:"name"`
	Depth int    `json:"depth"`
}

// ModelPrice is USD per million tokens.
type ModelPrice struct {
	Input     float64 `json:"input"`
	Output    float64 `json:"output"`
	CacheRead float64 `json:"cacheRead"`
}

type ProviderAuth struct {
	Kind    string `json:"kind"` // apiKey or subscription
	KeyHint string `json:"keyHint,omitempty"`
	// SignedIn: a subscription is signed in and can be used.
	SignedIn bool `json:"signedIn,omitempty"`
	// Login is a sign-in under way, or the Error of the last one.
	Login *LoginPrompt `json:"login,omitempty"`
}

// LoginPrompt is what the user has to do to sign in.
type LoginPrompt struct {
	Method   string `json:"method"` // browser, device or terminal
	URL      string `json:"url,omitempty"`
	UserCode string `json:"userCode,omitempty"`
	Command  string `json:"command,omitempty"`
	Error    string `json:"error,omitempty"`
}

// ModelProvider never holds the API key itself; that is a secret kept apart, by provider id.
type ModelProvider struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Kind    enum.ProviderKind `json:"kind"`
	Auth    ProviderAuth      `json:"auth"`
	BaseURL string            `json:"baseUrl"`
	Models  []string          `json:"models"`
	// Thinking lists the levels each model reports it accepts, weakest first. Nil until the provider was asked.
	Thinking map[string][]string   `json:"thinking"`
	Prices   map[string]ModelPrice `json:"prices,omitempty"`
	// ContextWindow is how many tokens its models can read, as the user set it. Only kinds with no fixed size keep one;
	// 0 when it was never set.
	ContextWindow int `json:"contextWindow,omitempty"`
}

const (
	// ContextAnthropic and ContextOpenAI are the fixed sizes of those kinds' models.
	ContextAnthropic = 1_000_000
	ContextOpenAI    = 272_000
	// ContextUnknown is assumed for a provider whose size was never set.
	ContextUnknown = 128_000
	// ContextLeast and ContextMost bound what the user may set.
	ContextLeast = 8_000
	ContextMost  = 10_000_000
)

// ContextWindow is how many tokens a provider's models can read.
func ContextWindow(p ModelProvider) int {
	switch {
	case p.Kind == enum.ProviderAnthropic:
		return ContextAnthropic
	case p.Kind == enum.ProviderOpenAI:
		return ContextOpenAI
	case p.ContextWindow > 0:
		return p.ContextWindow
	}
	return ContextUnknown
}

// FixedContext says whether a provider's kind decides its size, so there is none to set.
func FixedContext(kind enum.ProviderKind) bool {
	return kind == enum.ProviderAnthropic || kind == enum.ProviderOpenAI
}

// MakesImages says whether a provider can be the one that draws pictures: only a ChatGPT subscription can.
func MakesImages(p ModelProvider) bool {
	return p.Kind == enum.ProviderOpenAI && p.Auth.Kind == "subscription"
}

// ThinkingDefault leaves how hard a model thinks to its provider. Every model takes it.
const ThinkingDefault = "default"

// ModelSpec is a model as its provider describes it.
type ModelSpec struct {
	ID string
	// Thinking lists the levels the model accepts, weakest first; empty when the provider doesn't say.
	Thinking []string
}

// Quota is what a provider reports of its allowance. A field it doesn't report stays nil.
type Quota struct {
	// FiveHour and Weekly are how much of a subscription's 5-hour and weekly limits is used, 0 to 100.
	FiveHour *float64 `json:"fiveHour,omitempty"`
	Weekly   *float64 `json:"weekly,omitempty"`
	// FiveHourResetAt and WeeklyResetAt are when those limits start over, in Unix seconds; 0 when not reported.
	FiveHourResetAt int64 `json:"fiveHourResetAt,omitempty"`
	WeeklyResetAt   int64 `json:"weeklyResetAt,omitempty"`
	// Balance is the money left on an API key's account, in Currency (USD, CNY, ...).
	Balance  *float64 `json:"balance,omitempty"`
	Currency string   `json:"currency,omitempty"`
}

// World is everything the backend knows. Conversations stay inside the backend, so clients never get them.
type World struct {
	Preferences   Preferences               `json:"preferences"`
	Tutorial      Tutorial                  `json:"tutorial"`
	Now           float64                   `json:"now"`
	Seq           int                       `json:"seq"`
	Language      string                    `json:"language"`
	Teams         map[string]*Team          `json:"teams"`
	Providers     map[string]*ModelProvider `json:"providers"`
	Blueprints    map[string]*Blueprint     `json:"blueprints"`
	Sources       map[string]*Source        `json:"sources"`
	Replicas      map[string]*Replica       `json:"replicas"`
	Workflows     map[string]*Workflow      `json:"workflows"`
	Tasks         map[string]*Task          `json:"tasks"`
	SubTasks      map[string]*SubTask       `json:"subTasks"`
	Chats         map[string]*Chat          `json:"chats"`
	Conversations map[string][]Message      `json:"-"`
}

// The languages of the app and of what employees write to the user.
const (
	LanguageZh = "zh"
	LanguageEn = "en"
)

// SourcePreset marks a blueprint built into the app. Built-in blueprints and flows have ids starting with PresetPrefix:
// they cannot be changed or deleted and are not kept in the settings files, and copies of them get ids of their own.
const (
	SourcePreset = "preset"
	PresetPrefix = "preset-"
)

func IsPresetID(id string) bool { return strings.HasPrefix(id, PresetPrefix) }

func NewWorld() *World {
	return &World{
		Language: LanguageZh, Preferences: DefaultPreferences(), Tutorial: Tutorial{Done: []string{}, Shown: []string{}, Played: []string{}, Actions: []string{}, Copies: []string{}},
		Teams: map[string]*Team{}, Providers: map[string]*ModelProvider{}, Blueprints: map[string]*Blueprint{}, Sources: map[string]*Source{},
		Replicas: map[string]*Replica{}, Workflows: map[string]*Workflow{}, Tasks: map[string]*Task{},
		SubTasks: map[string]*SubTask{}, Chats: map[string]*Chat{}, Conversations: map[string][]Message{},
	}
}

// Block is one piece of a model message.
type Block struct {
	Type     enum.BlockType  `json:"type"`
	Text     string          `json:"text,omitempty"`
	ID       string          `json:"id,omitempty"` // tool call id, on calls and their results
	Name     string          `json:"name,omitempty"`
	Args     json.RawMessage `json:"args,omitempty"`
	MimeType string          `json:"mimeType,omitempty"`
	Data     string          `json:"data,omitempty"` // base64 image
	IsError  bool            `json:"isError,omitempty"`
}

type Message struct {
	Role    enum.Role `json:"role"`
	Content []Block   `json:"content"`
	// By is the employee who wrote it, in a chat, so a meeting shows each one the others' words as said to them.
	By string `json:"by,omitempty"`
}

type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type ModelRequest struct {
	// Cwd is the working directory, and Session names the conversation; providers may reuse what they
	// keep for it between calls.
	Cwd      string
	Session  string
	Model    string
	Effort   string
	System   string
	Messages []Message
	Tools    []ToolSpec
}

type ModelUsage struct {
	Input     int
	Output    int
	CacheRead int // part of Input
}

// ModelReply is a finished model call. Tool calls and text are in Content.
type ModelReply struct {
	Content []Block
	Usage   ModelUsage
	// Truncated means the model ran out of output tokens; its tool calls were dropped.
	Truncated bool
}

// ToolResult is what a tool tells the model. Stop ends the run once the result is recorded.
type ToolResult struct {
	Text    string
	IsError bool
	Stop    bool
	// After runs once the results of the tools before it are recorded, when Stop is set. What the user can answer
	// opens here, so that the answer cannot come ahead of those results.
	After func()
	// MimeType and Data carry an image for the model to see, as base64, alongside Text.
	MimeType string
	Data     string
}

// Doc is one stored entity, as JSON.
type Doc struct {
	Kind string
	ID   string
	Data []byte
}
