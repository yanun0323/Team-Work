package usecase_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/model/enum"
	"github.com/yanun0323/Team-Work/internal/repository"
	"github.com/yanun0323/Team-Work/internal/usecase"
)

// brokenDisk is a store whose writes fail while broken is set, as with a full disk, and for the next fails writes.
type brokenDisk struct {
	*repository.Store
	broken atomic.Bool
	fails  atomic.Int32
}

func (s *brokenDisk) Apply(ctx context.Context, upserts, deletes []model.Doc, secrets []model.SecretChange, settings ...model.SettingsChange) error {
	if s.broken.Load() || s.fails.Add(-1) >= 0 {
		return errors.New("disk full")
	}
	return s.Store.Apply(ctx, upserts, deletes, secrets, settings...)
}

// diskRig is a rig whose store can be broken; its engine is reopened on the same data with reopen.
func diskRig(t *testing.T) (*rig, *brokenDisk, func()) {
	t.Helper()
	r := newRig(t, func(model.ModelRequest) (model.ModelReply, error) { return say("好"), nil })
	r.e.Close()
	r.store.Close()
	var disk *brokenDisk
	open := func() {
		store, err := repository.NewStore(r.data)
		if err != nil {
			t.Fatal(err)
		}
		disk = &brokenDisk{Store: store}
		e, err := usecase.NewEngine(context.Background(), usecase.Options{
			Store: disk, Git: repository.NewGit(r.data), Providers: r.fake, DataDir: r.data, Log: zerolog.Nop(),
		})
		if err != nil {
			t.Fatal(err)
		}
		r.e, r.store = e, store
		t.Cleanup(func() { e.Close(); store.Close() })
	}
	open()
	reopen := func() {
		r.e.Close()
		r.store.Close()
		open()
	}
	return r, disk, reopen
}

// A change the disk does not take fails, and is not there, nor is anything it started.
func TestAChangeThatCannotBeSavedFails(t *testing.T) {
	t.Parallel()
	r, disk, reopen := diskRig(t)
	disk.broken.Store(true)
	if _, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"}); err == nil {
		t.Fatal("a chat that was not saved was made")
	}
	if _, err := r.e.CreateTask(usecase.NewTask{Legacy: true, TeamID: r.team.ID, Title: "沒存到", WorkflowID: r.flow.ID}); err == nil {
		t.Fatal("a task that was not saved was made")
	}
	time.Sleep(200 * time.Millisecond)
	if w := r.world(); len(w.Chats) > 0 || len(w.Tasks) > 0 {
		t.Fatalf("chats %v, tasks %v", w.Chats, w.Tasks)
	}

	// once the disk takes it again, the same change goes through and stays
	disk.broken.Store(false)
	c, err := r.e.CreateChat(usecase.NewChat{TeamID: r.team.ID, ReplicaID: r.owner.ID, Text: "嗨"})
	if err != nil {
		t.Fatal(err)
	}
	r.wait("reply", chatDone(c.ID))
	reopen()
	if w := r.world(); len(w.Chats) != 1 {
		t.Fatalf("chats %v", w.Chats)
	}
}

// A provider's key changes with the change it belongs to: when that cannot be saved, the key stays as it was.
func TestAKeyChangesOnlyWithItsSettings(t *testing.T) {
	t.Parallel()
	r, disk, reopen := diskRig(t)
	ctx := context.Background()
	p := providerNamed(r.world(), "p")

	disk.broken.Store(true)
	login := &usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-lost-5678"}
	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{Login: login}); err == nil {
		t.Fatal("no error")
	}
	if _, err := r.e.AddProvider(ctx, usecase.NewProvider{Name: "新", Kind: enum.ProviderCompatible, BaseURL: "https://x.test/v1",
		Login: usecase.ProviderLogin{Kind: "apiKey", APIKey: "sk-new-0001"}}); err == nil {
		t.Fatal("no error")
	}
	if err := r.e.DeleteProvider(ctx, p.ID); err == nil {
		t.Fatal("no error")
	}
	disk.broken.Store(false)
	secrets, err := r.store.LoadSecrets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if secrets[p.ID] != "sk-secret-1234" || len(secrets) != 1 {
		t.Fatalf("keys changed without their settings: %v", secrets)
	}
	if got := r.world().Providers[p.ID]; got == nil || got.Auth.KeyHint != "1234" {
		t.Fatalf("%+v", got)
	}
	// the key in use is still the old one
	r.e.RefreshModels(ctx, p.ID)
	if got := r.fake.askedWith("sk-lost-5678"); len(got) > 1 {
		t.Fatalf("the lost key was used afterwards: %v", got)
	}

	if err := r.e.UpdateProvider(ctx, p.ID, usecase.ProviderPatch{Login: login}); err != nil {
		t.Fatal(err)
	}
	reopen()
	if got := secretOf(t, r, p.ID); got != "sk-lost-5678" || r.world().Providers[p.ID].Auth.KeyHint != "5678" {
		t.Fatalf("key %q, provider %+v", got, r.world().Providers[p.ID])
	}
}
