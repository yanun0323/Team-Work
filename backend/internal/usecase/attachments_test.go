package usecase_test

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yanun0323/mho-company/internal/model"
	"github.com/yanun0323/mho-company/internal/model/enum"
	"github.com/yanun0323/mho-company/internal/usecase"
)

func textFile(name, text string) model.Attachment {
	return model.Attachment{Name: name, URL: "data:text/plain;base64," + base64.StdEncoding.EncodeToString([]byte(text))}
}

func TestFileAttachmentsReachChatsAndTasks(t *testing.T) {
	for _, task := range []bool{false, true} {
		name := "chat"
		if task {
			name = "task"
		}
		t.Run(name, func(t *testing.T) {
			files := []model.Attachment{textFile("../../requirements.txt", "attached requirements"), textFile("requirements.txt", "second file"), {Name: "empty.bin", URL: "data:application/octet-stream;base64,"}}
			var paths []string
			r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
				if lastIsResult(req) {
					result := req.Messages[len(req.Messages)-1].Content[0]
					if result.IsError || result.Text != "attached requirements" {
						t.Errorf("read_file: %+v", result)
					}
					if task {
						return call("submit_handoff", handoff), nil
					}
					return say("read"), nil
				}
				blocks := req.Messages[0].Content
				for _, block := range blocks {
					if !strings.HasPrefix(block.Text, "Attached file") {
						continue
					}
					_, rest, _ := strings.Cut(block.Text, "read-only path: ")
					path, _, _ := strings.Cut(rest, "\n")
					paths = append(paths, path)
					if block.Type != enum.BlockText {
						t.Errorf("not text: %+v", block)
					}
				}
				if len(paths) < 3 {
					t.Errorf("missing files: %+v", blocks)
					return say("missing"), nil
				}
				return call("read_file", map[string]any{"path": paths[0]}), nil
			})
			var id string
			if task {
				made, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "files", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Files: files})
				if err != nil {
					t.Fatal(err)
				}
				id = made.ID
				r.wait("task", stage(id, enum.StageAwaitMerge))
				if !slices.Equal(r.world().Tasks[id].Files, files) {
					t.Fatal("lost task files")
				}
			} else {
				made, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Files: files})
				if err != nil {
					t.Fatal(err)
				}
				id = made.ID
				r.wait("chat", chatDone(id))
				if !slices.Equal(r.world().Chats[id].Messages[0].Files, files) {
					t.Fatal("lost chat files")
				}
				r.e.Close()
				newEngine(t, r)
				if !slices.Equal(r.world().Chats[id].Messages[0].Files, files) {
					t.Fatal("lost files after restart")
				}
				if err := r.e.RewindChat(id, 0); err != nil {
					t.Fatal(err)
				}
				if err := r.e.SayInChat(id, "", nil, files); err != nil {
					t.Fatal(err)
				}
				r.wait("resend", chatDone(id))
			}
			if len(paths) < 3 || paths[0] == paths[1] {
				t.Fatalf("paths: %v", paths)
			}
			for i, path := range paths[:3] {
				rel, err := filepath.Rel(filepath.Join(r.data, "attachments", id), path)
				if err != nil || strings.HasPrefix(rel, "..") {
					t.Fatalf("unsafe path %s", path)
				}
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				_, encoded, _ := strings.Cut(files[i].URL, ",")
				if base64.StdEncoding.EncodeToString(raw) != encoded {
					t.Fatal("bytes changed")
				}
			}
			if gitOut(t, r.folder, "status", "--porcelain") != "" {
				t.Fatal("attachments dirtied project")
			}
		})
	}
}

func TestInvalidFileAttachmentsAreRejectedBeforeMutation(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("chat", chatDone(c.ID))
	for _, files := range [][]model.Attachment{
		{{URL: "https://example.com/file.txt"}},
		{{URL: "data:text/plain;base64,***"}},
		{textFile("large.txt", strings.Repeat("x", (5<<20)/4*3+1))},
		slices.Repeat([]model.Attachment{textFile("a.txt", "a")}, 7),
	} {
		if _, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Files: files}); err == nil {
			t.Fatal("created invalid chat")
		}
		if err := r.e.SayInChat(c.ID, "", nil, files); err == nil {
			t.Fatal("sent invalid files")
		}
		if _, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "bad", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Files: files}); err == nil {
			t.Fatal("created invalid task")
		}
	}
	if err := r.e.SayInChat(c.ID, "", slices.Repeat([]model.Attachment{{URL: pngURL}}, 6), []model.Attachment{textFile("a.txt", "a")}); err == nil {
		t.Fatal("accepted seven mixed attachments")
	}
	w := r.world()
	if len(w.Chats) != 1 || len(w.Tasks) != 0 || len(w.Chats[c.ID].Messages) != 2 {
		t.Fatal("invalid request changed world")
	}
}
