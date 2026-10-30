// Package enum holds the domain's fixed sets of values. Spellings match the frontend's types.
package enum

type Status string

const (
	StatusTodo        Status = "todo"
	StatusProgressing Status = "progressing"
	StatusReview      Status = "review"
	StatusComplete    Status = "complete"
)

type Assignment string

const (
	AssignFirstAvailable Assignment = "firstAvailable"
	AssignEveryone       Assignment = "everyone"
)

type HandoffMode string

const (
	HandoffPickOne HandoffMode = "pickOne"
	HandoffAll     HandoffMode = "all"
)

type JoinMode string

const (
	JoinAny JoinMode = "any"
	JoinAll JoinMode = "all"
)

type NodeKind string

const (
	NodeTask NodeKind = "task"
	NodeWork NodeKind = "work"
	NodeTalk NodeKind = "talk"
)

type ReviewKind string

const (
	ReviewQuestion  ReviewKind = "question"
	ReviewPickRoute ReviewKind = "pickRoute"
	ReviewFailed    ReviewKind = "failed"
	ReviewBudget    ReviewKind = "budget"
	ReviewTalk      ReviewKind = "talk"
)

type LogKind string

const (
	LogThink  LogKind = "think"
	LogTool   LogKind = "tool"
	LogSay    LogKind = "say"
	LogSystem LogKind = "system"
	LogHuman  LogKind = "human"
)

type TaskStage string

const (
	StageRunning    TaskStage = "running"
	StageAwaitMerge TaskStage = "awaitMerge"
	StageMerging    TaskStage = "merging"
	StageDone       TaskStage = "done"
	StageCancelled  TaskStage = "cancelled"
)

type ProviderKind string

const (
	ProviderAnthropic  ProviderKind = "anthropic"
	ProviderOpenAI     ProviderKind = "openai"
	ProviderGoogle     ProviderKind = "google"
	ProviderCompatible ProviderKind = "compatible"
)

type Tool string

const (
	ToolReadFile   Tool = "readFile"
	ToolWriteFile  Tool = "writeFile"
	ToolWebSearch  Tool = "webSearch"
	ToolRunCommand Tool = "runCommand"
)

type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

type BlockType string

const (
	BlockText       BlockType = "text"
	BlockImage      BlockType = "image"
	BlockToolCall   BlockType = "tool_call"
	BlockToolResult BlockType = "tool_result"
)
