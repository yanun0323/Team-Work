// Package delivery is the HTTP and WebSocket API.
package delivery

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/adapter"
	"github.com/yanun0323/Team-Work/internal/i18n"
	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/usecase"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

const (
	// bodyLimit leaves room for pictures attached to a task, which arrive as data URLs.
	bodyLimit    = "32M"
	pingInterval = 30 * time.Second
	writeTimeout = 10 * time.Second
)

type serializer struct{}

func (serializer) Serialize(c echo.Context, v any, _ string) error {
	raw, err := jsonx.Marshal(v)
	if err != nil {
		return err
	}
	_, err = c.Response().Write(raw)
	return err
}

func (serializer) Deserialize(c echo.Context, v any) error {
	raw, err := io.ReadAll(c.Request().Body)
	if err != nil {
		return err
	}
	return jsonx.Unmarshal(raw, v)
}

// Server maps requests onto the engine. It has no business logic of its own.
type Server struct {
	engine    *usecase.Engine
	claude    adapter.ClaudeCode
	folders   adapter.FolderPicker
	terminals adapter.Terminals
	origins   []string
	log       zerolog.Logger
	echo      *echo.Echo
}

func NewServer(engine *usecase.Engine, claude adapter.ClaudeCode, folders adapter.FolderPicker, terminals adapter.Terminals, origins []string, log zerolog.Logger) *Server {
	s := &Server{engine: engine, claude: claude, folders: folders, terminals: terminals, origins: origins, log: log, echo: echo.New()}
	e := s.echo
	e.HideBanner, e.HidePort = true, true
	e.JSONSerializer = serializer{}
	e.HTTPErrorHandler = s.handleError
	e.Use(middleware.Recover(), s.guard, middleware.BodyLimit(bodyLimit))

	api := e.Group("/api/v1")
	api.GET("/world", s.world)
	api.POST("/settings/reload", s.reloadSettings)
	api.POST("/settings/open-folder", s.openSettingsFolder)
	api.PUT("/settings/language", s.setLanguage)
	api.PATCH("/settings/preferences", s.updatePreferences)
	api.PATCH("/tutorial", s.updateTutorial)
	api.GET("/settings/global-prompt", s.globalPrompt)
	api.PUT("/settings/global-prompt", s.setGlobalPrompt)
	api.GET("/events", s.events)

	api.POST("/teams", s.createTeam)
	api.PATCH("/teams/:id", s.updateTeam)
	api.POST("/teams/:id/prompt/refresh", s.refreshPrompt)
	api.GET("/teams/:id/notes", s.notes)
	api.PUT("/teams/:id/notes", s.setNotes)
	api.DELETE("/teams/:id", s.deleteTeam)
	api.POST("/workflows", s.createWorkflow)

	api.GET("/folders", s.browseFolders)
	api.GET("/branches", s.branches)
	api.POST("/folder-picker", s.pickFolder)
	api.PUT("/workflows/:id", s.saveWorkflow)
	api.POST("/workflows/:id/duplicate", s.duplicateWorkflow)
	api.DELETE("/workflows/:id", s.deleteWorkflow)
	api.PUT("/workflows/:id/hidden", s.hideWorkflow)

	api.POST("/providers", s.addProvider)
	api.PATCH("/providers/:id", s.updateProvider)
	api.DELETE("/providers/:id", s.deleteProvider)
	api.POST("/providers/:id/models", s.refreshModels)
	api.POST("/models/stale", s.refreshStaleModels)
	api.POST("/providers/:id/login", s.startLogin)
	api.POST("/providers/:id/login/paste", s.pasteLogin)
	api.DELETE("/providers/:id/login", s.cancelLogin)
	api.POST("/providers/:id/logout", s.logout)
	api.GET("/quotas", s.quotas)
	api.GET("/usage", s.usage)

	api.GET("/claude-code", s.claudeStatus)
	api.POST("/claude-code/install", s.claudeInstall)
	api.POST("/claude-code/login", s.claudeLogin)

	api.GET("/git", s.gitStatus)
	api.POST("/git/install", s.gitInstall)

	api.POST("/blueprints", s.createBlueprint)
	api.PUT("/blueprints/:id", s.saveBlueprint)
	api.DELETE("/blueprints/:id", s.deleteBlueprint)
	api.PUT("/blueprints/:id/hidden", s.hideBlueprint)
	api.POST("/blueprints/:id/update", s.updateBlueprint)
	api.GET("/blueprints/:id/skills", s.blueprintSkills)

	api.POST("/sources", s.addSource)
	api.POST("/sources/preview", s.previewSource)
	api.DELETE("/sources/:id", s.deleteSource)
	api.GET("/sources/:id/items", s.sourceItems)
	api.GET("/sources/:id/problems", s.sourceProblems)
	api.GET("/sources/:id/skill", s.sourceSkill)
	api.POST("/sources/:id/check", s.checkSource)
	api.GET("/sources/:id/changes", s.sourceChanges)
	api.POST("/sources/:id/apply", s.applySource)
	api.PUT("/sources/:id/auto-apply", s.sourceAutoApply)
	api.POST("/sources/:id/seen", s.seeSource)

	api.POST("/replicas", s.hire)
	api.PATCH("/replicas/:id", s.updateReplica)
	api.DELETE("/replicas/:id", s.fire)
	api.POST("/replicas/:id/move", s.moveReplica)
	api.GET("/replicas/:id/export", s.exportReplica)

	api.POST("/tasks", s.createTask)
	api.PATCH("/tasks/:id", s.updateTask)
	api.DELETE("/tasks/:id", s.deleteTask)
	api.POST("/tasks/:id/pause", s.taskAction(engine.PauseTask))
	api.POST("/tasks/:id/resume", s.taskAction(engine.ResumeTask))
	api.POST("/tasks/:id/cancel", s.taskAction(engine.CancelTask))
	api.POST("/tasks/:id/merge", s.taskAction(engine.MergeTask))
	api.POST("/tasks/:id/return", s.returnTask)
	api.POST("/tasks/:id/workflow", s.changeWorkflow)
	api.GET("/tasks/:id/activity", s.taskActivity)
	api.GET("/tasks/:id/activity/:activityId", s.taskActivityEntry)
	api.GET("/tasks/:id/operations/:operationId", s.taskOperation)
	api.POST("/tasks/:id/messages", s.sayToOwner)
	api.POST("/tasks/:id/meetings/:meetingId/control", s.controlMeeting)
	api.GET("/tasks/:id/meetings/:meetingId/activity", s.meetingActivity)
	api.POST("/tasks/:id/control", s.controlTask)

	api.GET("/subtasks/:id/file", s.handedFile)
	api.GET("/subtasks/:id/image", s.handedImage)
	api.GET("/subtasks/:id/diff", s.handedDiff)
	api.POST("/subtasks/:id/review", s.resolveReview)
	api.POST("/subtasks/:id/talk", s.sayInTalk)
	api.POST("/subtasks/:id/talk/end", s.endTalk)

	api.GET("/teams/:id/uncommitted", s.uncommitted)
	api.GET("/teams/:id/files", s.searchFiles)
	api.GET("/replicas/:id/skills", s.replicaSkills)
	api.POST("/teams/:id/open-folder", s.openFolder)
	api.GET("/teams/:id/file", s.projectFile)
	api.PUT("/teams/:id/file", s.saveProjectFile)
	api.GET("/teams/:id/tree", s.projectTree)
	api.POST("/teams/:id/tree", s.createProjectEntry)
	api.GET("/teams/:id/image", s.projectImage)
	api.GET("/chats/:id/skill", s.chatSkill)
	api.GET("/chats/:id/messages", s.chatMessages)
	api.GET("/teams/:id/terminal", s.terminal)
	api.GET("/teams/:id/health", s.teamHealth)
	api.GET("/teams/:id/size", s.projectSize)
	api.POST("/attachments", s.uploadAttachment)
	api.GET("/attachments/:hash", s.downloadAttachment)

	api.POST("/chats", s.createChat)
	api.POST("/airport/chats", s.createAirportChat)
	api.GET("/airport/skills", s.airportSkills)
	// the airport's chats have no company: their "#" paths are at home, and these take no id
	api.GET("/airport/files", s.searchFiles)
	api.POST("/airport/open-folder", s.openFolder)
	api.GET("/airport/file", s.projectFile)
	api.GET("/airport/image", s.projectImage)
	api.GET("/airport/terminal", s.terminal)
	api.PATCH("/chats/:id/mind", s.setChatMind)
	api.PATCH("/chats/:id/title", s.renameChat)
	api.PATCH("/chats/:id/pin", s.pinChat)
	api.PATCH("/chats/:id/chair", s.setChatChair)
	api.POST("/chats/:id/guests", s.inviteToChat)
	api.POST("/chats/:id/say", s.sayInChat)
	api.POST("/chats/:id/stop", s.stopChat)
	api.POST("/chats/:id/retry", s.retryChat)
	api.POST("/chats/:id/queue/:queued/steer", s.steerChat)
	api.DELETE("/chats/:id/queue/:queued", s.unqueueChat)
	api.POST("/chats/:id/read", s.readChat)
	api.POST("/chats/:id/question/skip", s.skipChatQuestion)
	api.POST("/chats/:id/rewind", s.rewindChat)
	api.POST("/chats/:id/handoff", s.handOffChat)
	api.POST("/chats/:id/change", s.resolveChatChange)
	api.POST("/chats/:id/task-draft", s.chatTaskDraft)
	api.DELETE("/chats/:id", s.deleteChat)
	return s
}

func (s *Server) Handler() http.Handler { return s.echo }

// Serve answers on the listener until ctx ends, then lets requests finish.
func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	s.echo.Listener = l
	done := make(chan error, 1)
	go func() {
		<-ctx.Done()
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		done <- s.echo.Shutdown(stop)
	}()
	if err := s.echo.Start(""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return <-done
}

func hostOnly(hostport string) string {
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		return host
	}
	return hostport
}

func isLocal(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// guard keeps web pages out. The API has no sign-in and its employees run commands, so another site open
// in the user's browser must not reach it: the Host header stops DNS rebinding, the Origin header stops
// cross-site requests. Tools that are not browsers send no Origin.
func (s *Server) guard(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := c.Request()
		if !isLocal(hostOnly(req.Host)) {
			return model.Errorf(codeForbidden, "這個位址不能連到 API")
		}
		origin := req.Header.Get("Origin")
		if origin == "" {
			return next(c)
		}
		if !slices.Contains(s.origins, origin) {
			return model.Errorf(codeForbidden, "這個來源不能連到 API")
		}
		h := c.Response().Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Add("Vary", "Origin")
		if req.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
			h.Set("Access-Control-Allow-Headers", "Content-Type")
			return c.NoContent(http.StatusNoContent)
		}
		return next(c)
	}
}

const codeForbidden = "forbidden"

func (s *Server) handleError(err error, c echo.Context) {
	if c.Response().Committed {
		return
	}
	code, message, status := model.CodeInternal, i18n.T("伺服器發生錯誤"), http.StatusInternalServerError
	var known *model.Error
	var web *echo.HTTPError
	switch {
	case errors.As(err, &known):
		code, message = known.Code, known.Message
		switch known.Code {
		case model.CodeNotFound:
			status = http.StatusNotFound
		case model.CodeInvalid, model.CodeSignedOut:
			status = http.StatusBadRequest
		case model.CodeConflict, "incompatible":
			status = http.StatusConflict
		case model.CodeUnsupported:
			status = http.StatusUnsupportedMediaType
		case model.CodeUnavailable:
			status = http.StatusBadGateway
		case "unauthorized":
			status = http.StatusUnauthorized
		case "pair_self":
			status = http.StatusBadRequest
		case codeForbidden, "peer_denied", "peer_unpaired", "remote_unavailable", "peer_blocked", "peer_kicked", "peer_readonly":
			status = http.StatusForbidden
		}
	case errors.As(err, &web) && web.Code < 500:
		status, code = web.Code, model.CodeInvalid
		message = http.StatusText(web.Code)
	default:
		s.log.Error().Err(err).Str("path", c.Path()).Msg("request failed")
	}
	if err := c.JSON(status, map[string]map[string]string{"error": {"code": code, "message": message}}); err != nil {
		s.log.Error().Err(err).Msg("write error response")
	}
}

// bind reads a JSON body; a body that does not fit is the client's mistake.
func bind[T any](c echo.Context) (T, error) {
	var v T
	if err := c.Echo().JSONSerializer.Deserialize(c, &v); err != nil {
		return v, model.Errorf(model.CodeInvalid, "請求內容不是正確的 JSON")
	}
	return v, nil
}

func created(c echo.Context, v any, err error) error {
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, v)
}

func done(c echo.Context, err error) error {
	if err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

func (s *Server) reloadSettings(c echo.Context) error {
	return done(c, s.engine.ReloadSettings(c.Request().Context()))
}

func (s *Server) chatMessages(c echo.Context) error {
	before, err := strconv.Atoi(c.QueryParam("before"))
	if err != nil {
		return model.Errorf(model.CodeInvalid, "訊息範圍不正確")
	}
	limit := 100
	if c.QueryParam("limit") != "" {
		limit, err = strconv.Atoi(c.QueryParam("limit"))
		if err != nil {
			return model.Errorf(model.CodeInvalid, "訊息範圍不正確")
		}
	}
	out, err := s.engine.ChatMessages(c.Param("id"), c.QueryParam("version"), before, limit)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}

func (s *Server) world(c echo.Context) error {
	var raw []byte
	var err error
	if c.QueryParam("chats") == "paged" {
		raw, err = s.engine.PagedSnapshot()
	} else {
		raw, err = s.engine.Snapshot()
	}
	if err != nil {
		return err
	}
	return c.JSONBlob(http.StatusOK, raw)
}

func (s *Server) createTeam(c echo.Context) error {
	in, err := bind[usecase.NewTeam](c)
	if err != nil {
		return err
	}
	out, err := s.engine.CreateTeam(c.Request().Context(), in)
	return created(c, out, err)
}

func (s *Server) updateTeam(c echo.Context) error {
	in, err := bind[usecase.TeamPatch](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.UpdateTeam(c.Param("id"), in))
}

func (s *Server) setLanguage(c echo.Context) error {
	in, err := bind[struct {
		Language string `json:"language"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SetLanguage(in.Language))
}

func (s *Server) refreshPrompt(c echo.Context) error {
	return done(c, s.engine.RefreshPrompt(c.Param("id")))
}

func (s *Server) notes(c echo.Context) error {
	text, err := s.engine.Notes(c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]string{"text": text})
}

func (s *Server) setNotes(c echo.Context) error {
	in, err := bind[struct {
		Text string `json:"text"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SetNotes(c.Param("id"), in.Text))
}

func (s *Server) deleteTeam(c echo.Context) error {
	return done(c, s.engine.DeleteTeam(c.Param("id")))
}

func (s *Server) createWorkflow(c echo.Context) error {
	in, err := bind[struct {
		Name string `json:"name"`
	}](c)
	if err != nil {
		return err
	}
	out, err := s.engine.CreateWorkflow(in.Name)
	return created(c, out, err)
}

func (s *Server) branches(c echo.Context) error {
	branches, repo, err := s.engine.Branches(c.Request().Context(), c.QueryParam("folder"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"branches": branches, "repo": repo})
}

func (s *Server) pickFolder(c echo.Context) error {
	// net/http only notices a client leaving once the body has been read, and the dialog should close with it
	if _, err := io.Copy(io.Discard, c.Request().Body); err != nil {
		return model.Errorf(model.CodeInvalid, "請求內容無法讀取")
	}
	path, err := s.folders.PickFolder(c.Request().Context())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"path": path})
}

func (s *Server) duplicateWorkflow(c echo.Context) error {
	out, err := s.engine.DuplicateWorkflow(c.Param("id"))
	return created(c, out, err)
}

func (s *Server) updateTask(c echo.Context) error {
	in, err := bind[usecase.TaskPatch](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.UpdateTask(c.Param("id"), in))
}

func (s *Server) saveWorkflow(c echo.Context) error {
	in, err := bind[model.Workflow](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SaveWorkflow(c.Param("id"), in))
}

func (s *Server) deleteWorkflow(c echo.Context) error {
	return done(c, s.engine.DeleteWorkflow(c.Param("id")))
}

type hiddenBody struct {
	Hidden bool `json:"hidden"`
}

func (s *Server) hideWorkflow(c echo.Context) error {
	in, err := bind[hiddenBody](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.HideWorkflow(c.Param("id"), in.Hidden))
}

func (s *Server) addProvider(c echo.Context) error {
	in, err := bind[usecase.NewProvider](c)
	if err != nil {
		return err
	}
	out, err := s.engine.AddProvider(c.Request().Context(), in)
	return created(c, out, err)
}

func (s *Server) updateProvider(c echo.Context) error {
	in, err := bind[usecase.ProviderPatch](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.UpdateProvider(c.Request().Context(), c.Param("id"), in))
}

func (s *Server) deleteProvider(c echo.Context) error {
	return done(c, s.engine.DeleteProvider(c.Request().Context(), c.Param("id")))
}

func (s *Server) refreshModels(c echo.Context) error {
	return done(c, s.engine.RefreshModels(c.Request().Context(), c.Param("id")))
}

// refreshStaleModels is a list of models being opened: providers not asked for ModelsFresh are asked again, in the
// background, and the answer comes back as a change to the world.
func (s *Server) refreshStaleModels(c echo.Context) error {
	s.engine.RefreshStaleModels(usecase.ModelsFresh)
	return c.NoContent(http.StatusNoContent)
}

func (s *Server) startLogin(c echo.Context) error {
	in, err := bind[struct {
		Method string `json:"method"`
	}](c)
	if err != nil {
		return err
	}
	out, err := s.engine.StartLogin(c.Request().Context(), c.Param("id"), in.Method)
	return created(c, out, err)
}

func (s *Server) pasteLogin(c echo.Context) error {
	in, err := bind[struct {
		Value string `json:"value"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.PasteLogin(c.Param("id"), in.Value))
}

func (s *Server) cancelLogin(c echo.Context) error {
	return done(c, s.engine.CancelLogin(c.Param("id")))
}

func (s *Server) logout(c echo.Context) error {
	return done(c, s.engine.Logout(c.Request().Context(), c.Param("id")))
}

func (s *Server) quotas(c echo.Context) error {
	return c.JSON(http.StatusOK, s.engine.Quotas(c.Request().Context()))
}

// usage takes since (Unix seconds; 0 for all) and offset (the time zone, minutes east of UTC).
func (s *Server) usage(c echo.Context) error {
	since, err := strconv.ParseFloat(cmp.Or(c.QueryParam("since"), "0"), 64)
	if err != nil {
		return model.Errorf(model.CodeInvalid, "since 格式錯誤")
	}
	offset, err := strconv.Atoi(cmp.Or(c.QueryParam("offset"), "0"))
	if err != nil || offset < -14*60 || offset > 14*60 {
		return model.Errorf(model.CodeInvalid, "offset 格式錯誤")
	}
	stats, err := s.engine.Usage(c.Request().Context(), since, offset)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, stats)
}

func (s *Server) claudeStatus(c echo.Context) error {
	status, err := s.claude.Status(c.Request().Context())
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, status)
}

// claudeInstall downloads and runs a program, so it refuses to without the user's word. It ends with the
// request: a client that gives up stops the installer.
func (s *Server) claudeInstall(c echo.Context) error {
	in, err := bind[struct {
		Consent bool `json:"consent"`
	}](c)
	if err != nil {
		return err
	}
	if !in.Consent {
		return model.Errorf(model.CodeInvalid, "安裝 Claude Code 要先取得使用者同意")
	}
	return done(c, s.claude.Install(c.Request().Context()))
}

func (s *Server) gitStatus(c echo.Context) error {
	return c.JSON(http.StatusOK, s.engine.GitStatus(c.Request().Context()))
}

// gitInstall opens the system's installer, so it refuses to without the user's word.
func (s *Server) gitInstall(c echo.Context) error {
	in, err := bind[struct {
		Consent bool `json:"consent"`
	}](c)
	if err != nil {
		return err
	}
	if !in.Consent {
		return model.Errorf(model.CodeInvalid, "安裝 git 要先取得使用者同意")
	}
	return done(c, s.engine.InstallGit(c.Request().Context()))
}

func (s *Server) claudeLogin(c echo.Context) error {
	// net/http only notices a client leaving once the body has been read, and this request ends with the client
	if _, err := io.Copy(io.Discard, c.Request().Body); err != nil {
		return model.Errorf(model.CodeInvalid, "請求內容無法讀取")
	}
	return done(c, s.claude.Login(c.Request().Context()))
}

func (s *Server) createBlueprint(c echo.Context) error {
	in, err := bind[model.Blueprint](c)
	if err != nil {
		return err
	}
	out, err := s.engine.CreateBlueprint(in)
	return created(c, out, err)
}

func (s *Server) saveBlueprint(c echo.Context) error {
	in, err := bind[model.Blueprint](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SaveBlueprint(c.Param("id"), in))
}

func (s *Server) deleteBlueprint(c echo.Context) error {
	return done(c, s.engine.DeleteBlueprint(c.Param("id"), c.QueryParam("to")))
}

func (s *Server) hideBlueprint(c echo.Context) error {
	in, err := bind[hiddenBody](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.HideBlueprint(c.Param("id"), in.Hidden))
}

func (s *Server) updateBlueprint(c echo.Context) error {
	return done(c, s.engine.UpdateBlueprint(c.Request().Context(), c.Param("id")))
}

func (s *Server) hire(c echo.Context) error {
	in, err := bind[usecase.NewReplica](c)
	if err != nil {
		return err
	}
	out, err := s.engine.Hire(in)
	if err == nil {
		err = s.engine.PinOwnSources(c.Request().Context(), out.ID)
	}
	return created(c, out, err)
}

func (s *Server) updateReplica(c echo.Context) error {
	in, err := bind[usecase.ReplicaPatch](c)
	if err != nil {
		return err
	}
	if err := s.engine.UpdateReplica(c.Param("id"), in); err != nil {
		return err
	}
	return done(c, s.engine.PinOwnSources(c.Request().Context(), c.Param("id")))
}

func (s *Server) fire(c echo.Context) error {
	return done(c, s.engine.Fire(c.Param("id"), c.QueryParam("heir")))
}

func (s *Server) moveReplica(c echo.Context) error {
	in, err := bind[struct {
		To   string `json:"to"`
		Heir string `json:"heir"`
	}](c)
	if err != nil {
		return err
	}
	out, err := s.engine.MoveReplica(c.Param("id"), in.To, in.Heir)
	return created(c, out, err)
}

// exportReplica is an employee as another island copies them; files=1 brings their skills' files too.
func (s *Server) exportReplica(c echo.Context) error {
	out, err := s.engine.ExportReplica(c.Request().Context(), c.Param("id"), c.QueryParam("files") == "1")
	if err != nil {
		return err
	}
	c.Response().Header().Set("Cache-Control", "no-store")
	return c.JSON(http.StatusOK, out)
}

func (s *Server) createTask(c echo.Context) error {
	in, err := bind[usecase.NewTask](c)
	if err != nil {
		return err
	}
	out, err := s.engine.CreateTask(in)
	return created(c, out, err)
}

func (s *Server) deleteTask(c echo.Context) error {
	return done(c, s.engine.DeleteTask(c.Param("id")))
}

func (s *Server) taskAction(act func(string) error) echo.HandlerFunc {
	return func(c echo.Context) error { return done(c, act(c.Param("id"))) }
}

func (s *Server) returnTask(c echo.Context) error {
	in, err := bind[struct {
		Feedback string `json:"feedback"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.ReturnTask(c.Param("id"), in.Feedback))
}

// intQuery reads a whole number from the query; missing is 0.
func intQuery(c echo.Context, name string) (int, error) {
	raw := c.QueryParam(name)
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, model.Errorf(model.CodeInvalid, "分頁參數不正確")
	}
	return n, nil
}

func (s *Server) taskActivity(c echo.Context) error {
	before, err := intQuery(c, "before")
	if err != nil {
		return err
	}
	limit, err := intQuery(c, "limit")
	if err != nil {
		return err
	}
	if c.QueryParam("limit") != "" && limit == 0 {
		return model.Errorf(model.CodeInvalid, "分頁參數不正確")
	}
	page, err := s.engine.TaskActivity(c.Param("id"), before, limit, c.QueryParam("version"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, page)
}

func (s *Server) taskActivityEntry(c echo.Context) error {
	entry, err := s.engine.TaskActivityEntry(c.Param("id"), c.Param("activityId"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, entry)
}

func (s *Server) taskOperation(c echo.Context) error {
	op, err := s.engine.TaskOperation(c.Param("id"), c.Param("operationId"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, op)
}

func (s *Server) sayToOwner(c echo.Context) error {
	in, err := bind[usecase.TaskMessage](c)
	if err != nil {
		return err
	}
	out, err := s.engine.SayToOwner(c.Param("id"), in)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusAccepted, out)
}

func (s *Server) controlMeeting(c echo.Context) error {
	in, err := bind[usecase.MeetingControl](c)
	if err != nil {
		return err
	}
	op, err := s.engine.ControlMeeting(c.Param("id"), c.Param("meetingId"), in)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusAccepted, map[string]any{"operation": op})
}

func (s *Server) meetingActivity(c echo.Context) error {
	before, err := intQuery(c, "before")
	if err != nil {
		return err
	}
	limit, err := intQuery(c, "limit")
	if err != nil {
		return err
	}
	if c.QueryParam("limit") != "" && limit == 0 {
		return model.Errorf(model.CodeInvalid, "分頁參數不正確")
	}
	page, err := s.engine.MeetingActivity(c.Param("id"), c.Param("meetingId"), before, limit, c.QueryParam("version"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, page)
}

func (s *Server) controlTask(c echo.Context) error {
	in, err := bind[usecase.TaskControl](c)
	if err != nil {
		return err
	}
	op, err := s.engine.ControlTask(c.Param("id"), in)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusAccepted, map[string]any{"operation": op})
}

func (s *Server) changeWorkflow(c echo.Context) error {
	in, err := bind[struct {
		WorkflowID string `json:"workflowId"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.ChangeWorkflow(c.Param("id"), in.WorkflowID))
}

func (s *Server) resolveReview(c echo.Context) error {
	in, err := bind[struct {
		OptionID string `json:"optionId"`
		Note     string `json:"note"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.ResolveReview(c.Param("id"), in.OptionID, in.Note))
}

func (s *Server) handedFile(c echo.Context) error {
	text, err := s.engine.HandedFile(c.Request().Context(), c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"text": text})
}

func (s *Server) handedDiff(c echo.Context) error {
	lines, err := s.engine.HandedDiff(c.Request().Context(), c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]any{"lines": lines})
}

func (s *Server) handedImage(c echo.Context) error {
	data, kind, err := s.engine.HandedImage(c.Request().Context(), c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	return c.Blob(http.StatusOK, kind, data)
}

func (s *Server) sayInTalk(c echo.Context) error {
	in, err := bind[struct {
		Text     string   `json:"text"`
		Mentions []string `json:"mentions"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SayInTalk(c.Param("id"), in.Text, in.Mentions))
}

func (s *Server) endTalk(c echo.Context) error {
	in, err := bind[model.TalkEnd](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.EndTalk(c.Param("id"), in))
}

func (s *Server) openSettingsFolder(c echo.Context) error {
	return done(c, s.folders.OpenFolder(c.Request().Context(), s.engine.DataDir()))
}

func (s *Server) openFolder(c echo.Context) error {
	folder, err := s.engine.ProjectFolder(c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	if err := s.folders.OpenFolder(c.Request().Context(), folder); err != nil {
		return err
	}
	return done(c, s.engine.Learn("openFolder"))
}

func (s *Server) projectFile(c echo.Context) error {
	text, err := s.engine.ProjectFile(c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, text)
}

func (s *Server) projectTree(c echo.Context) error {
	tree, err := s.engine.ProjectTree(c.Request().Context(), c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, tree)
}

func (s *Server) saveProjectFile(c echo.Context) error {
	in, err := bind[struct {
		Path string  `json:"path"`
		Text *string `json:"text"`
		Hash string  `json:"hash"`
	}](c)
	if err != nil {
		return err
	}
	if in.Text == nil {
		return model.Errorf(model.CodeInvalid, "儲存內容必須是文字")
	}
	hash, err := s.engine.SaveProjectFile(c.Param("id"), in.Path, *in.Text, in.Hash)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]string{"hash": hash})
}

func (s *Server) createProjectEntry(c echo.Context) error {
	in, err := bind[struct {
		Parent string `json:"parent"`
		Name   string `json:"name"`
		Kind   string `json:"kind"`
	}](c)
	if err != nil {
		return err
	}
	entry, err := s.engine.CreateProjectEntry(c.Param("id"), in.Parent, in.Name, in.Kind)
	return created(c, entry, err)
}

func (s *Server) projectImage(c echo.Context) error {
	data, kind, err := s.engine.ProjectImage(c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
	return c.Blob(http.StatusOK, kind, data)
}

func (s *Server) chatSkill(c echo.Context) error {
	skill, err := s.engine.ChatSkill(c.Request().Context(), c.Param("id"), c.QueryParam("name"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, skill)
}

func (s *Server) teamHealth(c echo.Context) error {
	health, err := s.engine.TeamHealth(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, health)
}

func (s *Server) projectSize(c echo.Context) error {
	size, err := s.engine.ProjectSize(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, size)
}

func (s *Server) uncommitted(c echo.Context) error {
	dirty, err := s.engine.Uncommitted(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]bool{"uncommitted": dirty})
}

func (s *Server) searchFiles(c echo.Context) error {
	files, err := s.engine.SearchFiles(c.Request().Context(), c.Param("id"), c.QueryParam("q"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, files)
}

func (s *Server) replicaSkills(c echo.Context) error {
	skills, err := s.engine.ReplicaSkills(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, skills)
}

func (s *Server) airportSkills(c echo.Context) error {
	return c.JSON(http.StatusOK, s.engine.AirportSkills(c.Request().Context()))
}

func (s *Server) blueprintSkills(c echo.Context) error {
	skills, err := s.engine.BlueprintSkills(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, skills)
}

func (s *Server) addSource(c echo.Context) error {
	in, err := bind[usecase.NewSource](c)
	if err != nil {
		return err
	}
	out, err := s.engine.AddSource(c.Request().Context(), in)
	return created(c, out, err)
}

func (s *Server) previewSource(c echo.Context) error {
	in, err := bind[usecase.NewSource](c)
	if err != nil {
		return err
	}
	out, err := s.engine.PreviewSource(c.Request().Context(), in)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}

func (s *Server) deleteSource(c echo.Context) error {
	return done(c, s.engine.DeleteSource(c.Param("id")))
}

func (s *Server) sourceItems(c echo.Context) error {
	items, err := s.engine.SourceItems(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, items)
}

func (s *Server) sourceSkill(c echo.Context) error {
	skill, err := s.engine.SourceSkill(c.Request().Context(), c.Param("id"), c.QueryParam("path"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, skill)
}

func (s *Server) sourceProblems(c echo.Context) error {
	problems, err := s.engine.SourceProblems(c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, problems)
}

func (s *Server) checkSource(c echo.Context) error {
	return done(c, s.engine.CheckSource(c.Request().Context(), c.Param("id")))
}

func (s *Server) sourceChanges(c echo.Context) error {
	out, err := s.engine.SourceUpdateChanges(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}

func (s *Server) applySource(c echo.Context) error {
	return done(c, s.engine.ApplySource(c.Request().Context(), c.Param("id")))
}

func (s *Server) seeSource(c echo.Context) error {
	return done(c, s.engine.SeeSource(c.Param("id")))
}

func (s *Server) sourceAutoApply(c echo.Context) error {
	in, err := bind[struct {
		On bool `json:"on"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SetSourceAutoApply(c.Param("id"), in.On))
}

func (s *Server) createChat(c echo.Context) error {
	in, err := bind[usecase.NewChat](c)
	if err != nil {
		return err
	}
	out, err := s.engine.CreateChat(in)
	if err == nil && c.QueryParam("chats") == "paged" {
		raw, err := s.engine.ChatSummaryJSON(out.ID)
		if err != nil {
			return err
		}
		return c.JSONBlob(http.StatusCreated, raw)
	}
	return created(c, out, err)
}

func (s *Server) createAirportChat(c echo.Context) error {
	in, err := bind[usecase.NewAirportChat](c)
	if err != nil {
		return err
	}
	out, err := s.engine.CreateAirportChat(in)
	if err == nil && c.QueryParam("chats") == "paged" {
		raw, err := s.engine.ChatSummaryJSON(out.ID)
		if err != nil {
			return err
		}
		return c.JSONBlob(http.StatusCreated, raw)
	}
	return created(c, out, err)
}

func (s *Server) setChatMind(c echo.Context) error {
	in, err := bind[struct {
		Model  string `json:"model"`
		Effort string `json:"effort"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SetChatMind(c.Param("id"), in.Model, in.Effort))
}

func (s *Server) renameChat(c echo.Context) error {
	in, err := bind[struct {
		Title string `json:"title"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.RenameChat(c.Param("id"), in.Title))
}

func (s *Server) pinChat(c echo.Context) error {
	in, err := bind[struct {
		Pinned bool `json:"pinned"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.PinChat(c.Param("id"), in.Pinned))
}

func (s *Server) uploadAttachment(c echo.Context) error {
	url, err := s.engine.SaveUpload(c.Request().Body)
	return created(c, map[string]string{"url": url}, err)
}

func (s *Server) downloadAttachment(c echo.Context) error {
	f, err := s.engine.UploadFile(c.Param("hash"))
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	// Only raster images may render inline; HTML and SVG remain downloads.
	var head [512]byte
	n, _ := f.ReadAt(head[:], 0)
	mime := http.DetectContentType(head[:n])
	h := c.Response().Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	h.Set("X-Content-Type-Options", "nosniff")
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		h.Set("Content-Type", mime)
		h.Set("Content-Disposition", "inline")
	}
	http.ServeContent(c.Response(), c.Request(), "", info.ModTime(), f)
	return nil
}

func (s *Server) sayInChat(c echo.Context) error {
	in, err := bind[struct {
		Text     string             `json:"text"`
		Images   []model.Attachment `json:"images"`
		Files    []model.Attachment `json:"files"`
		Mentions []string           `json:"mentions"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SayInChatTo(c.Param("id"), in.Text, in.Images, in.Files, in.Mentions))
}

func (s *Server) setChatChair(c echo.Context) error {
	in, err := bind[struct {
		ReplicaID string `json:"replicaId"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SetChatChair(c.Param("id"), in.ReplicaID))
}

func (s *Server) inviteToChat(c echo.Context) error {
	in, err := bind[struct {
		ReplicaID string `json:"replicaId"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.InviteToChat(c.Param("id"), in.ReplicaID))
}

func (s *Server) rewindChat(c echo.Context) error {
	in, err := bind[struct {
		Index   int    `json:"index"`
		Version string `json:"version"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.RewindChat(c.Param("id"), in.Index, in.Version))
}

func (s *Server) resolveChatChange(c echo.Context) error {
	in, err := bind[struct {
		Approve bool   `json:"approve"`
		Note    string `json:"note"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.ResolveChatChange(c.Param("id"), in.Approve, in.Note))
}

func (s *Server) handOffChat(c echo.Context) error {
	in, err := bind[struct {
		Index     int    `json:"index"`
		Version   string `json:"version"`
		ReplicaID string `json:"replicaId"`
	}](c)
	if err != nil {
		return err
	}
	out, err := s.engine.HandOffChat(c.Param("id"), in.Index, in.ReplicaID, in.Version)
	if err == nil && c.QueryParam("chats") == "paged" {
		raw, err := s.engine.ChatSummaryJSON(out.ID)
		if err != nil {
			return err
		}
		return c.JSONBlob(http.StatusCreated, raw)
	}
	return created(c, out, err)
}

func (s *Server) stopChat(c echo.Context) error {
	return done(c, s.engine.StopChat(c.Param("id")))
}

func (s *Server) retryChat(c echo.Context) error {
	return done(c, s.engine.RetryChat(c.Param("id")))
}

func (s *Server) steerChat(c echo.Context) error {
	return done(c, s.engine.SteerChat(c.Param("id"), c.Param("queued")))
}

func (s *Server) unqueueChat(c echo.Context) error {
	return done(c, s.engine.UnqueueChat(c.Param("id"), c.Param("queued")))
}

func (s *Server) readChat(c echo.Context) error {
	return done(c, s.engine.ReadChat(c.Param("id")))
}

func (s *Server) skipChatQuestion(c echo.Context) error {
	return done(c, s.engine.SkipChatQuestion(c.Param("id")))
}

func (s *Server) deleteChat(c echo.Context) error {
	return done(c, s.engine.DeleteChat(c.Param("id")))
}

func (s *Server) chatTaskDraft(c echo.Context) error {
	out, err := s.engine.ChatTaskDraft(c.Request().Context(), c.Param("id"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, out)
}

// events sends the world, then every change to it. The goroutines here end with the connection.
func (s *Server) events(c echo.Context) error {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }} // guard has checked it
	conn, err := up.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		return nil // the upgrader has answered
	}
	defer conn.Close()
	snapshot, events, cancel, err := s.engine.SubscribeChats(c.QueryParam("chats") == "paged")
	if err != nil {
		return nil
	}
	defer cancel()

	closed := make(chan struct{})
	go func() { // reads only to notice the client leaving
		defer close(closed)
		for {
			if _, _, err := conn.NextReader(); err != nil {
				return
			}
		}
	}()
	write := func(kind int, data []byte) error {
		if err := conn.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
			return err
		}
		return conn.WriteMessage(kind, data)
	}
	first, err := jsonx.Marshal(struct {
		Type  string          `json:"type"`
		World json.RawMessage `json:"world"`
	}{"snapshot", snapshot})
	if err != nil || write(websocket.TextMessage, first) != nil {
		return nil
	}
	ping := time.NewTicker(pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-closed:
			return nil
		case <-ping.C:
			if write(websocket.PingMessage, nil) != nil {
				return nil
			}
		case ev, ok := <-events:
			if !ok { // too slow, or the server is closing: the client connects again for a new snapshot
				return nil
			}
			raw, err := jsonx.Marshal(ev)
			if err != nil || write(websocket.TextMessage, raw) != nil {
				return nil
			}
		}
	}
}

func (s *Server) globalPrompt(c echo.Context) error {
	prompt, err := s.engine.GlobalPrompt()
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, map[string]string{"prompt": prompt})
}

func (s *Server) setGlobalPrompt(c echo.Context) error {
	in, err := bind[struct {
		Prompt string `json:"prompt"`
	}](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.SetGlobalPrompt(in.Prompt))
}

func (s *Server) updatePreferences(c echo.Context) error {
	in, err := bind[map[string]json.RawMessage](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.UpdatePreferences(in))
}

func (s *Server) updateTutorial(c echo.Context) error {
	in, err := bind[model.TutorialPatch](c)
	if err != nil {
		return err
	}
	return done(c, s.engine.UpdateTutorial(in))
}
