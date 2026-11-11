package usecase

import (
	"fmt"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func TestPagedClientsGetOnlyTheNewestLogLines(t *testing.T) {
	e, _ := storageEngine(t)
	s := &model.SubTask{ID: "s", TaskID: "t", Log: []model.LogLine{}}
	for i := 0; i < 100; i++ {
		s.Log = append(s.Log, model.LogLine{At: float64(i), Text: fmt.Sprint(i)})
	}
	short := &model.SubTask{ID: "short", TaskID: "t", Log: []model.LogLine{{Text: "only"}}}
	e.w.SubTasks[s.ID] = s
	e.w.SubTasks[short.ID] = short
	if err := e.sync(); err != nil {
		t.Fatal(err)
	}
	newest := func(t *testing.T, got model.SubTask, last int) {
		t.Helper()
		if len(got.Log) != logShown || got.Log[0].Text != fmt.Sprint(last-logShown+1) || got.Log[logShown-1].Text != fmt.Sprint(last) {
			t.Fatalf("got %d lines, want the newest %d up to %d", len(got.Log), logShown, last)
		}
	}

	raw, err := e.PagedSnapshot()
	if err != nil {
		t.Fatal(err)
	}
	var paged model.World
	if err = jsonx.Unmarshal(raw, &paged); err != nil {
		t.Fatal(err)
	}
	newest(t, *paged.SubTasks["s"], 99)
	if len(paged.SubTasks["short"].Log) != 1 {
		t.Fatal("short log changed")
	}
	raw, err = e.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	var full model.World
	if err = jsonx.Unmarshal(raw, &full); err != nil {
		t.Fatal(err)
	}
	if len(full.SubTasks["s"].Log) != 100 {
		t.Fatal("full snapshot lost log lines")
	}

	_, small, cancel, err := e.SubscribeChats(true)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	_, all, cancelAll, err := e.Subscribe()
	if err != nil {
		t.Fatal(err)
	}
	defer cancelAll()
	s.Log = append(s.Log, model.LogLine{At: 100, Text: "100"})
	if err = e.sync(); err != nil {
		t.Fatal(err)
	}
	var got model.SubTask
	if err = jsonx.Unmarshal((<-small).Upserts[0].Data, &got); err != nil {
		t.Fatal(err)
	}
	newest(t, got, 100)
	if err = jsonx.Unmarshal((<-all).Upserts[0].Data, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Log) != 101 {
		t.Fatal("full event lost log lines")
	}
	if len(s.Log) != 101 {
		t.Fatal("trimming changed the engine's sub-task")
	}
}
