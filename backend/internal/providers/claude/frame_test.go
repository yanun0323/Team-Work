package claude

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"
)

func TestSendFitsAMessageWithSixLargestImages(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	go io.Copy(io.Discard, r)
	c := &child{stdin: w}
	image := strings.Repeat("A", 5<<20)
	blocks := make([]any, 6)
	for i := range blocks {
		blocks[i] = object{"type": "image", "source": object{"type": "base64", "media_type": "image/png", "data": image}}
	}
	if err := c.send(context.Background(), object{"type": "user", "message": object{"role": "user", "content": blocks}}); err != nil {
		t.Fatal(err)
	}
}
