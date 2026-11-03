package tools

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"strings"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model/enum"
)

type pageTransport func(*http.Request) (*http.Response, error)

func (f pageTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func page(status int, contentType, body string) *http.Client {
	return &http.Client{Transport: pageTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
}

func TestSearchingAllowsFetching(t *testing.T) {
	var names []string
	for _, tool := range For([]enum.Tool{enum.ToolWebSearch}, Env{}) {
		names = append(names, tool.Spec().Name)
	}
	if strings.Join(names, ",") != "web_search,web_fetch" {
		t.Fatalf("%v", names)
	}
}

func TestFetchReadsTheMainText(t *testing.T) {
	client := page(200, "text/html; charset=utf-8", `<html><head><title>A &amp; B</title></head><body><nav>skip</nav><main><h1>Hello</h1><p>Read <b>this</b> &amp; that.</p><script>secret</script><p hidden>hidden</p><p>Last</p></main></body></html>`)
	r := Fetch{Client: client}.Run(context.Background(), "", json.RawMessage(`{"url":"https://example.org","offset":2,"limit":1}`))
	if r.IsError {
		t.Fatal(r.Text)
	}
	var out struct {
		Title, Content, URL string
		Next                int `json:"next_offset"`
		Total               int `json:"total_paragraphs"`
	}
	if err := json.Unmarshal([]byte(r.Text), &out); err != nil {
		t.Fatal(err)
	}
	if out.Title != "A & B" || out.Content != "[2] Read this & that." || out.Next != 3 || out.Total != 3 || out.URL != "https://example.org" {
		t.Fatal(r.Text)
	}
}

func TestFetchDecodesThePageCharset(t *testing.T) {
	client := page(200, "text/plain; charset=big5", "\xa4\xa4\xa4\xe5") // 中文 in Big5
	r := Fetch{Client: client}.Run(context.Background(), "", json.RawMessage(`{"url":"https://example.org"}`))
	if r.IsError || !strings.Contains(r.Text, "[1] 中文") {
		t.Fatal(r.Text)
	}
}

func TestFetchSplitsLongParagraphsWithoutSplittingCharacters(t *testing.T) {
	client := page(200, "text/plain", strings.Repeat("字", maxParagraph))
	r := Fetch{Client: client}.Run(context.Background(), "", json.RawMessage(`{"url":"https://example.org"}`))
	var out struct {
		Content string
		Total   int `json:"total_paragraphs"`
	}
	// 12000 bytes of three-byte characters: the most a part can hold is 3999 bytes, so four parts
	if r.IsError || json.Unmarshal([]byte(r.Text), &out) != nil || out.Total != 4 || !utf8Valid(out.Content) {
		t.Fatalf("%d paragraphs, error %v", out.Total, r.IsError)
	}
	for _, p := range strings.Split(out.Content, "\n\n") {
		if _, text, _ := strings.Cut(p, "] "); len(text) > maxParagraph {
			t.Fatalf("a paragraph has %d bytes", len(text))
		}
	}
}

func TestFetchStaysOffPrivateNetworks(t *testing.T) {
	for _, raw := range []string{`{}`, `{"url":"file:///etc/passwd"}`, `{"url":"http://localhost"}`, `{"url":"http://a.localhost"}`, `{"url":"https://user:pass@example.org"}`, `{"url":"https://example.org:8080"}`, `{"url":"https://example.org","limit":101}`, `{"url":"https://example.org","offset":-1}`, `{"url":"https://example.org","extra":true}`} {
		if r := (Fetch{Client: page(200, "text/plain", "x")}).Run(context.Background(), "", json.RawMessage(raw)); !r.IsError {
			t.Errorf("accepted %s", raw)
		}
	}
	for _, ip := range []string{"127.0.0.1", "::1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::ffff:192.168.1.1", "2002:7f00:1::", "64:ff9b::7f00:1", "fd00::1"} {
		if publicIP(netip.MustParseAddr(ip)) {
			t.Errorf("accepted %s", ip)
		}
	}
	if !publicIP(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("blocked a public address")
	}
	client := publicClient()
	if _, err := client.Get("http://127.0.0.1/"); err == nil {
		t.Fatal("connected to loopback")
	}
	req, _ := http.NewRequest(http.MethodGet, "http://localhost/", nil)
	if err := client.CheckRedirect(req, nil); err == nil {
		t.Fatal("followed a redirect to a private address")
	}
}

func TestFetchSaysWhyItFailed(t *testing.T) {
	for _, tc := range []struct {
		status           int
		kind, body, want string
	}{
		{403, "text/html", "login", "HTTP 403"},
		{200, "application/pdf", "pdf", "unsupported"},
		{200, "text/html", "<script>only JS</script>", "no readable text"},
		{200, "text/plain", strings.Repeat("x", maxPageBytes+1), "download limit"},
	} {
		r := Fetch{Client: page(tc.status, tc.kind, tc.body)}.Run(context.Background(), "", json.RawMessage(`{"url":"https://example.org"}`))
		if !r.IsError || !strings.Contains(r.Text, tc.want) {
			t.Errorf("%s: %+v, want %s", tc.want, r.Text, tc.want)
		}
	}
}
