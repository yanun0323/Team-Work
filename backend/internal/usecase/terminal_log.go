package usecase

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/width"

	"github.com/yanun0323/Team-Work/internal/model"
)

const (
	// terminalLogLines is how many lines a company's terminal keeps for its employees to read, as many as it
	// lets the user scroll back.
	terminalLogLines = 5000
	// terminalLogCol is as far right as a line goes, so a cursor sent far off does not fill memory with blanks.
	terminalLogCol    = 10000
	readTerminalLines = 200
	readTerminalMax   = 2000
	readTerminalBytes = 50 << 10
)

// TerminalLog is what a company's terminal has shown, as plain lines of text: the shell's output with its colors
// and cursor moves worked out, the way the lines end up on the screen. What full-screen programs such as vim show
// is left out.
type TerminalLog struct {
	mu    sync.Mutex
	lines []string
	cur   []cell
	col   int
	// pend is the start of a character or an escape sequence that the next output finishes
	pend   []byte
	state  escState
	params []byte
	alt    bool
	ended  bool
}

// cell is one column of a line. A wide character takes two: the second has no rune.
type cell struct {
	r     rune
	marks []rune
}

type escState uint8

const (
	escNone escState = iota
	escStart
	escCSI
	escOSC   // ends with BEL or ST
	escStr   // DCS, SOS, PM and APC, which end with ST
	escArg   // one more byte, as in the charset choice ESC ( B
	escStrSt // ESC seen inside a string, where ESC \ ends it
)

// TerminalOutput starts the log of a company's new terminal, in place of the one before. The shell's output is
// written to it, and End marks when the shell is gone.
func (e *Engine) TerminalOutput(teamID string) *TerminalLog {
	l := &TerminalLog{}
	e.termMu.Lock()
	defer e.termMu.Unlock()
	e.terms[teamID] = l
	return l
}

func (e *Engine) terminalLog(teamID string) *TerminalLog {
	e.termMu.Lock()
	defer e.termMu.Unlock()
	return e.terms[teamID]
}

// Write takes the shell's output as it comes, in any pieces.
func (l *TerminalLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	data := p
	if len(l.pend) > 0 {
		data = append(l.pend, p...)
		l.pend = nil
	}
	for i := 0; i < len(data); {
		b := data[i]
		if l.state != escNone || b < utf8.RuneSelf {
			l.byte(b)
			i++
			continue
		}
		if !utf8.FullRune(data[i:]) {
			l.pend = slices.Clone(data[i:])
			break
		}
		r, n := utf8.DecodeRune(data[i:])
		l.print(r)
		i += n
	}
	return len(p), nil
}

// End marks the shell as gone.
func (l *TerminalLog) End() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ended = true
}

// Tail is the last n lines, the one the cursor is on included, and whether the shell has ended.
func (l *TerminalLog) Tail(n int) ([]string, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	lines := l.lines
	if cur := lineText(l.cur); cur != "" {
		lines = append(slices.Clip(lines), cur)
	}
	return slices.Clone(lines[max(0, len(lines)-n):]), l.ended
}

func (l *TerminalLog) byte(b byte) {
	switch l.state {
	case escStart:
		l.state = escNone
		switch b {
		case '[':
			l.state, l.params = escCSI, l.params[:0]
		case ']':
			l.state = escOSC
		case 'P', 'X', '^', '_':
			l.state = escStr
		case '(', ')', '*', '+', '-', '.', '/', '#', '%', ' ':
			l.state = escArg
		}
	case escArg:
		l.state = escNone
	case escCSI:
		switch {
		case b >= 0x40 && b <= 0x7e:
			l.state = escNone
			l.csi(b)
		case b >= 0x20:
			l.params = append(l.params, b)
		case b == 0x1b:
			l.state = escStart
		case b == 0x18 || b == 0x1a: // cancels the sequence
			l.state = escNone
		}
	case escOSC, escStr:
		switch b {
		case 0x07:
			if l.state == escOSC {
				l.state = escNone
			}
		case 0x1b:
			l.state = escStrSt
		case 0x18, 0x1a:
			l.state = escNone
		}
	case escStrSt:
		l.state = escNone
		if b != '\\' { // a new sequence; the string is over all the same
			l.state = escStart
			l.byte(b)
		}
	default:
		switch b {
		case 0x1b:
			l.state = escStart
		case '\r':
			l.col = 0
		case '\n':
			l.newline()
		case '\b':
			l.col = max(0, l.col-1)
		case '\t':
			l.col = min(terminalLogCol, (l.col/8+1)*8)
		default:
			if b >= 0x20 && b < 0x7f {
				l.print(rune(b))
			}
		}
	}
}

func (l *TerminalLog) print(r rune) {
	if l.alt {
		return
	}
	if r == utf8.RuneError || unicode.Is(unicode.C, r) && r != '‍' {
		return
	}
	if unicode.In(r, unicode.Mn, unicode.Me) || r == '‍' || unicode.Is(unicode.Variation_Selector, r) {
		if at := l.col - 1; at >= 0 && at < len(l.cur) { // with the character before it
			if l.cur[at].r == 0 && at > 0 {
				at--
			}
			l.cur[at].marks = append(l.cur[at].marks, r)
		}
		return
	}
	w := 1
	if k := width.LookupRune(r).Kind(); k == width.EastAsianWide || k == width.EastAsianFullwidth {
		w = 2
	}
	if l.col+w > terminalLogCol {
		return
	}
	for len(l.cur) < l.col+w {
		l.cur = append(l.cur, cell{r: ' '})
	}
	l.cur[l.col] = cell{r: r}
	if w == 2 {
		l.cur[l.col+1] = cell{}
	}
	l.col += w
}

func (l *TerminalLog) newline() {
	if l.alt {
		return
	}
	l.lines = append(l.lines, lineText(l.cur))
	if len(l.lines) > 2*terminalLogLines {
		l.lines = slices.Clone(l.lines[len(l.lines)-terminalLogLines:])
	}
	l.cur, l.col = l.cur[:0], 0
}

// csi carries out the cursor and erase commands that change how a line reads; the rest only change its looks.
func (l *TerminalLog) csi(final byte) {
	params := string(l.params)
	if final == 'h' || final == 'l' {
		if p, ok := strings.CutPrefix(params, "?"); ok {
			for _, mode := range strings.Split(p, ";") {
				if mode == "1049" || mode == "1047" || mode == "47" {
					l.alt = final == 'h'
				}
			}
		}
		return
	}
	if l.alt || strings.IndexAny(params, "?<=>") >= 0 {
		return
	}
	first, _, _ := strings.Cut(params, ";")
	n, err := strconv.Atoi(first)
	if err != nil {
		n = 0
	}
	count := max(1, n)
	switch final {
	case 'K':
		switch n {
		case 0:
			l.cur = l.cur[:min(l.col, len(l.cur))]
		case 1:
			for i := 0; i <= l.col && i < len(l.cur); i++ {
				l.cur[i] = cell{r: ' '}
			}
		case 2:
			l.cur = l.cur[:0]
		}
	case 'C':
		l.col = min(terminalLogCol, l.col+count)
	case 'D':
		l.col = max(0, l.col-count)
	case 'G':
		l.col = min(terminalLogCol, count-1)
	case 'P':
		if l.col < len(l.cur) {
			l.cur = slices.Delete(l.cur, l.col, min(len(l.cur), l.col+count))
		}
	case '@':
		if l.col < len(l.cur) {
			l.cur = slices.Insert(l.cur, l.col, slices.Repeat([]cell{{r: ' '}}, min(count, terminalLogCol))...)
		}
	case 'X':
		for i := l.col; i < l.col+count && i < len(l.cur); i++ {
			l.cur[i] = cell{r: ' '}
		}
	case 'J':
		// a cleared screen keeps what it showed here, as the history it is; the line being written starts afresh
		if (n == 2 || n == 3) && lineText(l.cur) != "" {
			l.newline()
		}
	}
}

func lineText(cells []cell) string {
	var b strings.Builder
	for _, c := range cells {
		if c.r != 0 {
			b.WriteRune(c.r)
		}
		for _, m := range c.marks {
			b.WriteRune(m)
		}
	}
	return strings.TrimRight(b.String(), " ")
}

var readTerminalSpec = model.ToolSpec{Name: "read_terminal", Description: "Read what the company's terminal, the shell the user opens in the app, has shown: its last lines as plain text, oldest first. You cannot type into it.",
	Parameters: json.RawMessage(`{"type":"object","properties":{"lines":{"type":"integer","minimum":1,"maximum":2000,"description":"How many of the last lines; 200 when left out"}}}`)}

// readTerminalTool reads the company's terminal for an employee who may read its files.
func (e *Engine) readTerminalTool(teamID string) funcTool {
	return funcTool{readTerminalSpec, func(_ context.Context, _ string, raw json.RawMessage) model.ToolResult {
		var a struct {
			Lines int `json:"lines"`
		}
		if len(raw) > 0 && json.Unmarshal(raw, &a) != nil {
			return toolError("lines must be a number")
		}
		n := readTerminalLines
		if a.Lines > 0 {
			n = min(a.Lines, readTerminalMax)
		}
		log := e.terminalLog(teamID)
		if log == nil {
			return model.ToolResult{Text: "The terminal has not been opened since the app started."}
		}
		lines, ended := log.Tail(n)
		text := strings.Join(lines, "\n")
		if len(text) > readTerminalBytes {
			text = text[len(text)-readTerminalBytes:]
			if i := strings.IndexByte(text, '\n'); i >= 0 {
				text = "[earlier lines cut]\n" + text[i+1:]
			}
		}
		if strings.TrimSpace(text) == "" {
			text = "The terminal shows nothing yet."
		}
		if ended {
			text += "\n[the shell has ended]"
		}
		return model.ToolResult{Text: text}
	}}
}
