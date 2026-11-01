package i18n

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

var (
	chinese = regexp.MustCompile(`\p{Han}`)
	verb    = regexp.MustCompile(`%[a-z]`)
)

// translators take a text in Chinese and put it in the current language.
var translators = []string{"T", "Errorf", "rejected", "unavailable", "bad"}

func callName(call *ast.CallExpr) string {
	switch f := call.Fun.(type) {
	case *ast.Ident:
		return f.Name
	case *ast.SelectorExpr:
		return f.Sel.Name
	}
	return ""
}

// Every Chinese text in the backend goes through a translator, inside a function so it is read when needed, and has English.
func TestEveryTextHasEnglish(t *testing.T) {
	seen := map[string]bool{}
	err := filepath.WalkDir("..", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || strings.HasSuffix(path, "en.go") {
			return err
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		var walk func(n ast.Node, inFunc bool, call string)
		walk = func(n ast.Node, inFunc bool, call string) {
			ast.Inspect(n, func(x ast.Node) bool {
				switch v := x.(type) {
				case *ast.FuncDecl, *ast.FuncLit:
					if x != n {
						walk(x, true, call)
						return false
					}
				case *ast.CallExpr:
					if x != n {
						walk(x, inFunc, callName(v))
						return false
					}
				case *ast.BasicLit:
					if v.Kind != token.STRING {
						return true
					}
					text, _ := strconv.Unquote(v.Value)
					if !chinese.MatchString(text) {
						return true
					}
					at := fset.Position(v.Pos())
					if !inFunc || !slices.Contains(translators, call) {
						t.Errorf("%s:%d: %q is not translated where it is used", at.Filename, at.Line, text)
					}
					seen[text] = true
					if _, ok := en[text]; !ok {
						t.Errorf("%s:%d: no English for %q", at.Filename, at.Line, text)
					}
				}
				return true
			})
		}
		walk(file, false, "")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for zh := range en {
		if !seen[zh] {
			t.Errorf("no one uses %q", zh)
		}
	}
}

func TestEnglishFillsTheSameValues(t *testing.T) {
	for zh, english := range en {
		if chinese.MatchString(english) {
			t.Errorf("Chinese in the English of %q: %s", zh, english)
		}
		if !slices.Equal(verb.FindAllString(zh, -1), verb.FindAllString(english, -1)) {
			t.Errorf("%q and %q fill in different values", zh, english)
		}
	}
}

func TestLanguagePicksTheText(t *testing.T) {
	t.Cleanup(func() { Set("") })
	Set("zh")
	if got := T("找不到公司"); got != "找不到公司" {
		t.Fatal(got)
	}
	Set(English)
	if got := T("找不到公司"); got != "Company not found" {
		t.Fatal(got)
	}
	if got := Errorf("一則訊息最多附 %d 張圖", 6).Error(); got != "A message can have at most 6 images" {
		t.Fatal(got)
	}
}
