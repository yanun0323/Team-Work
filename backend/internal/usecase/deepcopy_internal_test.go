package usecase

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/pkg/jsonx"
)

func sampleWorld() *model.World {
	w := model.NewWorld()
	w.Workflows["wf-1"] = &model.Workflow{ID: "wf-1", Name: "flow", Nodes: []model.WorkflowNode{{ID: "a", ReplicaIDs: []string{"rep-1"}}},
		Edges: []model.WorkflowEdge{}}
	w.Blueprints["bp-1"] = &model.Blueprint{ID: "bp-1", Name: "Dev", Prompt: "p"}
	w.Conversations = map[string][]model.Message{"chat-1": nil}
	w.Copies = map[string]string{"h": "rep-1"}
	return w
}

func TestDeepCopyIsApart(t *testing.T) {
	t.Parallel()
	w := sampleWorld()
	c := deepCopy(w)
	if !reflect.DeepEqual(w, c) {
		t.Fatal("the copy differs")
	}
	if c.Workflows["wf-1"].Edges == nil || c.Workflows["wf-1"].Nodes[0].ReplicaIDs == nil {
		t.Fatal("empty became nil")
	}
	if c.Copies["h"] != "rep-1" || len(c.Conversations) != 1 {
		t.Fatal("json:\"-\" fields were dropped")
	}
	c.Workflows["wf-1"].Nodes[0].ReplicaIDs[0] = "rep-2"
	c.Workflows["wf-1"].Name = "changed"
	c.Blueprints["bp-2"] = &model.Blueprint{ID: "bp-2"}
	c.Copies["h"] = "rep-2"
	if got := w.Workflows["wf-1"]; got.Nodes[0].ReplicaIDs[0] != "rep-1" || got.Name != "flow" {
		t.Fatalf("changing the copy changed the original: %+v", got)
	}
	if w.Blueprints["bp-2"] != nil || w.Copies["h"] != "rep-1" {
		t.Fatal("changing the copy's maps changed the original's")
	}
}

func TestEncodeCachedSeesChangesMadeInPlace(t *testing.T) {
	t.Parallel()
	w := sampleWorld()
	var cache map[string]encodedDoc
	encode := func() []byte {
		docs, next := map[string][]byte{}, map[string]encodedDoc{}
		encodeAll(docs, cache, next, "workflow", w.Workflows)
		cache = next
		return docs[docKey("workflow", "wf-1")]
	}
	first := encode()
	if want, _ := jsonx.Marshal(w.Workflows["wf-1"]); !bytes.Equal(first, want) {
		t.Fatalf("encoded %s, want %s", first, want)
	}
	if again := encode(); &again[0] != &first[0] {
		t.Fatal("an unchanged workflow was encoded again")
	}
	w.Workflows["wf-1"].Nodes[0].ReplicaIDs[0] = "rep-2" // deep inside, as the engine changes entities
	changed := encode()
	if want, _ := jsonx.Marshal(w.Workflows["wf-1"]); !bytes.Equal(changed, want) || bytes.Equal(changed, first) {
		t.Fatalf("a change made in place was missed: %s", changed)
	}
	delete(w.Workflows, "wf-1")
	if encode(); len(cache) != 0 {
		t.Fatal("a deleted workflow stayed in the cache")
	}
}
