package usecase

import (
	"reflect"
	"testing"
)

func TestSearchFiles(t *testing.T) {
	t.Parallel()
	files := []string{".env", "README.md", "src/app.go", "src/app_test.go", "src/ui/app.tsx", "docs/readme.txt"}
	cases := []struct {
		query string
		want  []FileInfo
	}{
		{"", []FileInfo{{Path: "docs", Dir: true}, {Path: "src", Dir: true}, {Path: "README.md"}}},
		{".", []FileInfo{{Path: ".env"}}},
		{"src/", []FileInfo{{Path: "src/ui", Dir: true}, {Path: "src/app.go"}, {Path: "src/app_test.go"}}},
		{"./src/ap", []FileInfo{{Path: "src/app.go"}, {Path: "src/app_test.go"}}},
		{"ui/app", []FileInfo{{Path: "src/ui/app.tsx"}}},
		{"read", []FileInfo{{Path: "README.md"}, {Path: "docs/readme.txt"}}},
		{"zzz", []FileInfo{}},
	}
	for _, c := range cases {
		if got := searchFiles(files, c.query, 50); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: %+v", c.query, got)
		}
	}
	if got := searchFiles(files, "", 1); len(got) != 1 {
		t.Errorf("limit: %+v", got)
	}
}
