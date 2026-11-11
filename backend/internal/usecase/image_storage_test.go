package usecase_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

func TestImagesStayOutOfStoredHistoryAndSnapshots(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("image", 200_000)))
	calls := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		calls++
		found := false
		for _, m := range req.Messages {
			for _, b := range m.Content {
				if b.Type == enum.BlockImage {
					found = true
					if b.Data != data {
						t.Error("provider lost original image bytes")
					}
				}
			}
		}
		if !found {
			t.Error("provider lost image")
		}
		return say("seen"), nil
	})
	// the image is over a megabyte, so a snapshot holding it would grow by far more than the chat adds
	before, err := r.e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Images: []model.Attachment{{Name: "a.png", URL: "data:image/png;base64," + data}}})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	raw, err := r.e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw)-len(before) > 50_000 || strings.Contains(string(raw), data) {
		t.Fatalf("snapshot retains image payload: %d bytes more", len(raw)-len(before))
	}
	docs, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if strings.Contains(string(d.Data), data) {
			t.Fatalf("%s retains image payload", d.Kind)
		}
	}
	image := r.world().Chats[c.ID].Messages[0].Images[0]
	f, err := r.e.UploadFile(strings.TrimPrefix(image.URL, "/api/v1/attachments/"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(f)
	f.Close()
	if err != nil || base64.StdEncoding.EncodeToString(got) != data {
		t.Fatal("stored image changed")
	}
	r.e.Close()
	newEngine(t, r)
	if err := r.e.SayInChat(c.ID, "again", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("reload", chatDone(c.ID))
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
}

func TestLegacyInlineImagesLoadAsReferencesWithoutLosingHistory(t *testing.T) {
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("ok"), nil })
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "old"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	before, err := r.e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	r.e.Close()
	docs, err := r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	data := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("old image", 100_000)))
	for i := range docs {
		d := &docs[i]
		if d.ID != c.ID {
			continue
		}
		switch d.Kind {
		case "chat":
			var old model.Chat
			if err := json.Unmarshal(d.Data, &old); err != nil {
				t.Fatal(err)
			}
			old.Messages[0].Images = []model.Attachment{{Name: "old.png", URL: "data:image/png;base64," + data}}
			d.Data, _ = json.Marshal(old)
		case "conv":
			d.Data, _ = json.Marshal([]model.Message{{Role: enum.RoleUser, Content: []model.Block{{Type: enum.BlockImage, MimeType: "image/png", Data: data}}}})
		}
	}
	if err := r.store.Apply(context.Background(), docs, nil, nil); err != nil {
		t.Fatal(err)
	}
	newEngine(t, r)
	raw, err := r.e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), data) || len(raw)-len(before) > 50_000 {
		t.Fatalf("legacy snapshot still carries image: %d bytes more", len(raw)-len(before))
	}
	if len(r.world().Chats[c.ID].Messages) != 2 {
		t.Fatal("history lost")
	}
	docs, err = r.store.LoadDocs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range docs {
		if strings.Contains(string(d.Data), data) {
			t.Fatalf("legacy %s still inline", d.Kind)
		}
	}
}

func TestUploadedImagesSurviveRewindForkAndTask(t *testing.T) {
	raw, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(pngURL, "data:image/png;base64,"))
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		found := false
		for _, m := range req.Messages {
			for _, b := range m.Content {
				if b.Type == enum.BlockImage {
					found = true
					if b.Data != strings.TrimPrefix(pngURL, "data:image/png;base64,") {
						t.Error("image changed")
					}
				}
			}
		}
		if !found {
			t.Error("image missing")
		}
		return say("ok"), nil
	})
	url, err := r.e.SaveUpload(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	images := []model.Attachment{{Name: "shot.png", URL: url, MimeType: "image/png"}}
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Images: images})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	fork, err := r.e.HandOffChat(c.ID, 1, r.owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.e.RewindChat(c.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := r.e.SayInChat(c.ID, "", images); err != nil {
		t.Fatal(err)
	}
	r.wait("resend", chatDone(c.ID))
	if err := r.e.SayInChat(fork.ID, "look again", nil); err != nil {
		t.Fatal(err)
	}
	r.wait("fork", chatDone(fork.ID))
	r.fake.mu.Lock()
	r.fake.reply = func(req model.ModelRequest) (model.ModelReply, error) {
		found := false
		for _, m := range req.Messages {
			for _, b := range m.Content {
				if b.Type == enum.BlockImage && b.Data == strings.TrimPrefix(pngURL, "data:image/png;base64,") {
					found = true
				}
			}
		}
		if !found {
			t.Error("task image missing")
		}
		return call("submit_handoff", handoff), nil
	}
	r.fake.mu.Unlock()
	task := r.start(r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "image", WorkflowID: r.flow.ID, OwnerID: &r.owner.ID, Images: images}))
	r.wait("task", stage(task.ID, enum.StageAwaitMerge))
	if r.world().Tasks[task.ID].Images[0].URL != url {
		t.Fatal("task lost reference")
	}
	for _, bad := range []model.Attachment{
		{URL: "/api/v1/attachments/" + strings.Repeat("0", 64), MimeType: "image/png"},
		{URL: url, MimeType: "image/jpeg"},
	} {
		if err := r.e.SayInChat(c.ID, "bad", []model.Attachment{bad}); err == nil {
			t.Fatal("accepted invalid reference")
		}
	}
}

func TestQueuedPicturesAreReferencesBeforeTheyAreSent(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	calls := 0
	r := newRig(t, func(req model.ModelRequest) (model.ModelReply, error) {
		calls++
		if calls == 1 {
			close(entered)
			<-release
		} else {
			b := req.Messages[len(req.Messages)-1].Content[0]
			if b.Type != enum.BlockImage || b.Data != strings.TrimPrefix(pngURL, "data:image/png;base64,") {
				t.Error("queued image missing")
			}
		}
		return say("ok"), nil
	})
	defer unblock()
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "wait"})
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	if err := r.e.SayInChat(c.ID, "", []model.Attachment{{URL: pngURL, Name: "queued.png"}}); err != nil {
		t.Fatal(err)
	}
	q := r.world().Chats[c.ID].Queue
	if len(q) != 1 || len(q[0].Images) != 1 || !strings.HasPrefix(q[0].Images[0].URL, "/api/v1/attachments/") {
		t.Fatal("queue retains inline image")
	}
	unblock()
	r.wait("queued reply", func(w *model.World) bool { return w.Chats[c.ID].ReplyAt == nil && len(w.Chats[c.ID].Queue) == 0 })
	if calls != 2 {
		t.Fatalf("calls %d", calls)
	}
}
