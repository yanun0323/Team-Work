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

func TestUploadedFilesReachChatsAndTasksByReference(t *testing.T) {
	content := strings.Repeat("uploaded ", 1<<20) // above the limit for inline data URLs
	var seen []string
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		for _, block := range req.Messages[0].Content {
			if strings.HasPrefix(block.Text, "Attached file") {
				seen = append(seen, block.Text)
			}
		}
		return say("ok"), nil
	})
	url, err := r.e.SaveUpload(strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	again, err := r.e.SaveUpload(strings.NewReader(content))
	if err != nil || again != url {
		t.Fatalf("same content: %s %s %v", url, again, err)
	}
	files := []model.Attachment{{Name: "notes.txt", URL: url}}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Files: files})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("chat", chatDone(c.ID))
	if len(seen) != 1 || !strings.Contains(seen[0], "[Preview truncated") || len(seen[0]) > 60<<10 {
		t.Fatalf("model got %d blocks, first %d bytes", len(seen), len(seen[0]))
	}
	_, rest, _ := strings.Cut(seen[0], "read-only path: ")
	path, _, _ := strings.Cut(rest, "\n")
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != content || filepath.Base(path) != "notes.txt" {
		t.Fatalf("attached copy at %s: %d bytes, %v", path, len(raw), err)
	}
	if !strings.HasPrefix(path, filepath.Join(r.data, "attachments", c.ID)) {
		t.Fatalf("outside the chat's root: %s", path)
	}
	if got := r.world().Chats[c.ID].Messages[0].Files; !slices.Equal(got, files) {
		t.Fatalf("world holds %+v", got)
	}

	if _, err := r.e.SaveUpload(strings.NewReader(strings.Repeat("x", 25<<20+1))); err == nil {
		t.Fatal("accepted an oversize upload")
	}
	missing := []model.Attachment{{Name: "gone", URL: "/api/v1/attachments/" + strings.Repeat("0", 64)}}
	escape := []model.Attachment{{Name: "bad", URL: "/api/v1/attachments/../../secret"}}
	for _, bad := range [][]model.Attachment{missing, escape} {
		if err := r.e.SayInChat(c.ID, "", nil, bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
		if _, err := r.e.CreateTask(usecase.NewTask{TeamID: r.team.ID, Title: "bad", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Files: bad}); err == nil {
			t.Fatalf("task accepted %+v", bad)
		}
	}
	if err := r.e.SayInChat(c.ID, "", []model.Attachment{{Name: "pic", URL: url}}); err == nil {
		t.Fatal("accepted an upload as an inline image")
	}
}
