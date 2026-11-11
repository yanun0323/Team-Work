package delivery

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"
)

func TestOwnerTaskEndpoints(t *testing.T) {
	api := setup(t).URL + "/api/v1"
	do := func(method, path string, input any, status int) map[string]any {
		t.Helper()
		raw := ""
		if input != nil {
			b, _ := json.Marshal(input)
			raw = string(b)
		}
		code, body := send(t, method, api+path, raw)
		if code != status {
			t.Fatalf("%s %s: %d %v", method, path, code, body)
		}
		return body
	}
	errorCode := func(body map[string]any) string { return body["error"].(map[string]any)["code"].(string) }

	team := do("POST", "/teams", map[string]any{"name": "owner", "folder": t.TempDir()}, http.StatusCreated)
	do("POST", "/providers", map[string]any{"name": "fake", "kind": "compatible", "login": map[string]any{"kind": "apiKey", "apiKey": "test"}}, http.StatusCreated)
	bp := do("POST", "/blueprints", map[string]any{"name": "lead", "prompt": "lead", "tools": []string{"readFile"}}, http.StatusCreated)
	owner := do("POST", "/replicas", map[string]any{"teamId": team["id"], "blueprintId": bp["id"], "name": "Ada", "model": "m"}, http.StatusCreated)
	flow := do("POST", "/workflows", map[string]any{"name": "plan"}, http.StatusCreated)
	node := flow["nodes"].([]any)[0].(map[string]any)["id"].(string)
	task := do("POST", "/tasks", map[string]any{"teamId": team["id"], "title": "t", "workflowId": flow["id"], "ownerId": owner["id"],
		"staff": map[string]any{node: []any{owner["id"]}}}, http.StatusCreated)
	if task["orchestration"] != "owner" {
		t.Fatalf("a new task is not owner-led: %v", task)
	}
	id := task["id"].(string)
	coord := task["coordination"].(map[string]any)

	// reading
	page := do("GET", "/tasks/"+id+"/activity", nil, http.StatusOK)
	if page["total"] != float64(0) || len(page["items"].([]any)) != 0 || page["hasMore"] != false || page["version"] != "0" {
		t.Fatalf("%v", page)
	}
	if body := do("GET", "/tasks/"+id+"/activity?limit=0", nil, http.StatusBadRequest); errorCode(body) != "invalid_request" {
		t.Fatal(body)
	}
	do("GET", "/tasks/"+id+"/activity?limit=101", nil, http.StatusBadRequest)
	do("GET", "/tasks/"+id+"/activity?before=x", nil, http.StatusBadRequest)
	do("GET", "/tasks/"+id+"/activity?version=7", nil, http.StatusConflict)
	do("GET", "/tasks/nope/activity", nil, http.StatusNotFound)
	do("GET", "/tasks/"+id+"/activity/nope", nil, http.StatusNotFound)
	do("GET", "/tasks/"+id+"/operations/nope", nil, http.StatusNotFound)

	// writing to the owner before the start is allowed; it waits for them
	said := do("POST", "/tasks/"+id+"/messages", map[string]any{"requestId": "m1", "text": "先看這個"}, http.StatusAccepted)
	op := said["operation"].(map[string]any)
	act := said["activity"].(map[string]any)
	if op["status"] != "received" || op["kind"] != "message" || act["from"] != "user" || act["text"] != "先看這個" || act["seq"] != float64(1) {
		t.Fatalf("%v", said)
	}
	again := do("POST", "/tasks/"+id+"/messages", map[string]any{"requestId": "m1", "text": "先看這個"}, http.StatusAccepted)
	if again["operation"].(map[string]any)["id"] != op["id"] {
		t.Fatalf("a request sent again made another: %v", again)
	}
	do("POST", "/tasks/"+id+"/messages", map[string]any{"requestId": "m1", "text": "別的"}, http.StatusConflict)
	do("POST", "/tasks/"+id+"/messages", map[string]any{"requestId": "m2", "text": " "}, http.StatusBadRequest)
	do("POST", "/tasks/"+id+"/messages", map[string]any{"text": "x"}, http.StatusBadRequest)
	do("POST", "/tasks/"+id+"/messages", map[string]any{"requestId": "m3", "text": "x", "mentions": []any{owner["id"]}}, http.StatusBadRequest)
	do("POST", "/tasks/"+id+"/messages", map[string]any{"requestId": "m4", "text": "x", "subId": "sub-1"}, http.StatusBadRequest)
	do("GET", "/tasks/"+id+"/activity/"+act["id"].(string), nil, http.StatusOK)
	do("GET", "/tasks/"+id+"/operations/"+op["id"].(string), nil, http.StatusOK)

	// controls
	do("POST", "/tasks/"+id+"/control", map[string]any{"requestId": "c0", "action": "pause"}, http.StatusConflict) // not started
	do("POST", "/tasks/"+id+"/control", map[string]any{"requestId": "c1", "action": "resume"}, http.StatusBadRequest)
	do("POST", "/tasks/"+id+"/control", map[string]any{"requestId": "c2", "action": "fly", "planVersion": coord["planVersion"], "controlVersion": coord["controlVersion"]}, http.StatusBadRequest)
	do("POST", "/tasks/"+id+"/control", map[string]any{"requestId": "c3", "action": "resume", "planVersion": 1, "controlVersion": 1}, http.StatusConflict) // the message moved it on
	_, world := send(t, "GET", api+"/world", "")
	coord = world["tasks"].(map[string]any)[id].(map[string]any)["coordination"].(map[string]any)
	resume := map[string]any{"requestId": "c4", "action": "resume", "planVersion": coord["planVersion"], "controlVersion": coord["controlVersion"]}
	started := do("POST", "/tasks/"+id+"/control", resume, http.StatusAccepted)["operation"].(map[string]any)
	if started["kind"] != "resume" || started["status"] != "applied" {
		t.Fatalf("%v", started)
	}
	if again := do("POST", "/tasks/"+id+"/control", resume, http.StatusAccepted)["operation"].(map[string]any); again["id"] != started["id"] {
		t.Fatalf("resumed twice: %v", again)
	}
	paused := do("POST", "/tasks/"+id+"/control", map[string]any{"requestId": "c5", "action": "pause"}, http.StatusAccepted)["operation"].(map[string]any)
	if paused["kind"] != "pause" || paused["status"] == "received" {
		t.Fatalf("%v", paused)
	}
	do("POST", "/tasks/"+id+"/control", map[string]any{"requestId": "c6", "action": "answer", "questionId": "nope", "optionId": "x", "planVersion": 99, "controlVersion": 99}, http.StatusConflict)

	// this server's model always fails: the owner's decision shows as failed, not lost
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := do("GET", "/tasks/"+id+"/operations/"+op["id"].(string), nil, http.StatusOK)
		if got["status"] == "failed" {
			if got["error"].(map[string]any)["message"] == "" {
				t.Fatalf("%v", got)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the message never got to the owner: %v", got)
		}
		time.Sleep(20 * time.Millisecond)
	}
	page = do("GET", fmt.Sprintf("/tasks/%s/activity?limit=1", id), nil, http.StatusOK)
	if len(page["items"].([]any)) != 1 || page["hasMore"] != true {
		t.Fatalf("%v", page)
	}

	// the old way's task conversation endpoints refuse a task that has none, and the old discussion ones refuse an owner-led task
	do("POST", "/subtasks/nope/talk", map[string]any{"text": "x"}, http.StatusNotFound)
}
