// Package adapter declares the ports between the backend's layers.
package adapter

import (
	"context"
	"encoding/json"
	"io"

	"github.com/yanun0323/Team-Work/internal/model"
)

// Store keeps entities as documents, and provider keys apart from them.
type Store interface {
	// With lazyConversations, conversation documents contain only kind and id.
	LoadDocs(ctx context.Context, lazyConversations ...bool) ([]model.Doc, error)
	LoadConversation(ctx context.Context, id string) ([]byte, error)
	InlineConversations(ctx context.Context) ([]string, error)
	// Apply writes runtime documents and provider keys transactionally. A settings change is journaled
	// in the same transaction and recovered before the next load after interruption.
	Apply(ctx context.Context, upserts, deletes []model.Doc, secrets []model.SecretChange, settings ...model.SettingsChange) error
	LoadSettings(ctx context.Context) (model.SettingsSnapshot, error)
	CheckSettings(expected model.SettingsSnapshot) error
	LoadSecrets(ctx context.Context) (map[string]string, error)
	// AddUsage records one model call; LoadUsage returns those made at or after since, oldest first.
	AddUsage(ctx context.Context, u model.Usage) error
	LoadUsage(ctx context.Context, since float64) ([]model.Usage, error)
	Secrets
}

// Secrets keeps credentials apart from everything else.
type Secrets interface {
	// Secret returns the secret of id, or "" when there is none.
	Secret(ctx context.Context, id string) (string, error)
	SetSecret(ctx context.Context, id, value string) error
	DeleteSecret(ctx context.Context, id string) error
}

// Provider runs one account's models.
type Provider interface {
	// Complete asks for the model's next message; onText receives its text as it is produced.
	// A failure worth retrying is a *model.Error with code unavailable.
	Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error)
	// Models lists what the account offers.
	Models(ctx context.Context) ([]model.ModelSpec, error)
}

// QuotaReader is a Provider that can tell how much of its allowance is left.
type QuotaReader interface {
	Quota(ctx context.Context) (model.Quota, error)
}

// Providers makes a Provider from an account and its key, and signs in to subscriptions.
type Providers interface {
	For(p model.ModelProvider, key string) (Provider, error)
	// Login starts signing in to a subscription by method (browser or device; empty for the default).
	Login(ctx context.Context, p model.ModelProvider, method string) (*LoginFlow, error)
	// Logout forgets what signing in saved.
	Logout(ctx context.Context, p model.ModelProvider) error
	// Images draws pictures with a signed-in ChatGPT subscription.
	Images(p model.ModelProvider) (ImageMaker, error)
}

// ImageMaker draws a PNG from a prompt, or edits the sources (data URLs) when there are any. With gif it draws a
// looping GIF instead.
type ImageMaker interface {
	MakeImage(ctx context.Context, prompt string, sources []string, transparent bool, gif *Gif) ([]byte, error)
}

// Gif asks for an animated GIF. A zero field leaves it to the service: 9 frames of 200 ms.
type Gif struct {
	Frames  int `json:"frame_count,omitempty"`
	FrameMS int `json:"frame_duration_ms,omitempty"`
}

// ClaudeStatus is where Claude Code stands on this computer. Models are ready to be given to a provider.
type ClaudeStatus struct {
	Installed bool     `json:"installed"`
	Version   string   `json:"version,omitempty"`
	SignedIn  bool     `json:"signedIn"`
	Models    []string `json:"models"`
}

// ClaudeCode sets up the program a Claude subscription runs through.
type ClaudeCode interface {
	Status(ctx context.Context) (ClaudeStatus, error)
	// Install downloads and runs Anthropic's installer; ask the user first.
	Install(ctx context.Context) error
	// Login runs its sign-in, which opens the browser, and returns once the user is through.
	Login(ctx context.Context) error
}

// LoginFlow is a sign-in under way: what to show the user, and how it ends.
type LoginFlow struct {
	Prompt model.LoginPrompt
	// Wait blocks until the sign-in is done and saved, or fails, or ctx ends.
	Wait func(ctx context.Context) error
	// Paste hands over what the browser ended on, when it could not come back by itself.
	Paste func(value string) error
}

// Tool is something a model can call.
type Tool interface {
	Spec() model.ToolSpec
	Run(ctx context.Context, cwd string, args json.RawMessage) model.ToolResult
}

// GitStatus is whether git can run on this computer. Installable is whether the app can install it, as on macOS.
type GitStatus struct {
	Installed   bool   `json:"installed"`
	Version     string `json:"version,omitempty"`
	Installable bool   `json:"installable"`
}

// Git does what a company's work needs from its repo.
type Git interface {
	// Tool says whether git can run here; nothing else works without it.
	Tool(ctx context.Context) GitStatus
	// InstallTool opens the system's own installer of git and returns once it is open; ask the user first.
	InstallTool(ctx context.Context) error
	// Prepare makes folder a repo when it is not one yet (with branch `master`), and lists its branches.
	Prepare(ctx context.Context, folder string) (branches []string, initialized bool, err error)
	// Branches lists a folder's branches without changing anything; repo is false when it is not a repo.
	Branches(ctx context.Context, folder string) (branches []string, repo bool, err error)
	// Uncommitted says whether a folder has changes not committed; a folder that is no repo has none.
	Uncommitted(ctx context.Context, folder string) (bool, error)
	// Tip is the commit branch points at, or HEAD's when branch is ""; "" when folder is no repo or has no such commit.
	Tip(ctx context.Context, folder, branch string) (string, error)
	// TreeBytes adds up the sizes of the files in a commit, as git records them, without reading any file.
	TreeBytes(ctx context.Context, folder, commit string) (int64, error)
	// Files lists the files under a folder for "#" mentions, relative to it with "/" separators: ignored ones too, but
	// not .git.
	Files(ctx context.Context, folder string) []string
	// Ignored says which of paths (relative, "/" separators, a folder ending in "/") git's ignore rules leave out; none
	// when folder is no repo.
	Ignored(ctx context.Context, folder string, paths []string) map[string]bool
	// Worktree makes, or finds, the task's work tree at dir on a new branch off target.
	Worktree(ctx context.Context, folder, dir, branch, target string) error
	// PrepareEnvironment prepares locked Node dependencies in the worktree, reporting progress before employees run.
	PrepareEnvironment(ctx context.Context, folder, dir string, report func(string)) error
	// Commit commits everything in the work tree and returns HEAD. Nothing to commit is no failure.
	Commit(ctx context.Context, dir, author, message string) (string, error)
	// MergeTarget merges target into the work tree. conflict leaves the merge open for someone to resolve.
	MergeTarget(ctx context.Context, dir, target string) (conflict bool, err error)
	// FinishMerge commits a resolved merge; it fails while files are still unmerged.
	FinishMerge(ctx context.Context, dir, author string) error
	// Land moves target up to branch, fast-forward only.
	Land(ctx context.Context, folder, branch, target string) error
	// Remove deletes the work tree and its branch.
	Remove(ctx context.Context, folder, dir, branch string) error
	// ReadFile returns a text file's content as it was at commit.
	ReadFile(ctx context.Context, folder, commit, path string) (string, error)
	// Diff returns a text file at commit against the same file at base, every line kept; nil when base has no such file.
	Diff(ctx context.Context, folder, base, commit, path string) ([]model.DiffLine, error)
	// ReadImage returns a PNG, JPEG, GIF or WebP as it was at commit, with its media type.
	ReadImage(ctx context.Context, folder, commit, path string) ([]byte, string, error)
	// Fetch makes a local copy of repo at commit (or at its default branch) and returns where it is.
	Fetch(ctx context.Context, repo, commit string) (string, error)
	// Cached says whether repo at commit is already here, so Fetch would read it without the network.
	Cached(repo, commit string) bool
	// Latest reports the commit ref points at upstream.
	Latest(ctx context.Context, repo, ref string) (string, error)
}

// Terminals starts shells for the user to type in.
type Terminals interface {
	Start(dir string, cols, rows uint16) (Terminal, error)
}

// Terminal is a running shell: what is written goes to it as typed, what is read is its screen output.
type Terminal interface {
	io.ReadWriteCloser
	Resize(cols, rows uint16) error
	// Exited is closed when the shell has ended, even if a job it left behind still holds its output open.
	Exited() <-chan struct{}
}

// FolderPicker asks the user for a folder on this computer. The path is empty when they cancelled.
type FolderPicker interface {
	PickFolder(ctx context.Context) (string, error)
	// OpenFolder shows a folder in the system's file browser.
	OpenFolder(ctx context.Context, path string) error
}
