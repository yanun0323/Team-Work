package codemode

import (
	_ "embed"
	"errors"
	"sync"
)

// qjsWasm is QuickJS-ng as WebAssembly, copied unchanged from github.com/fastschema/qjs at the version go.mod names:
// the Go side calls what this build exports, so the two are upgraded together (TestWasmMatchesTheModule checks).
//
//go:embed qjs.wasm
var qjsWasm []byte

// wasmPage is the size of a WebAssembly memory page.
const wasmPage = 64 << 10

// cappedWasm is qjsWasm whose memory cannot grow past MemoryLimit. QuickJS's own limit counts only what its
// allocator is asked for, so a script can still make the module's memory grow far beyond it; the module's maximum is
// what the WebAssembly runtime itself enforces.
var cappedWasm = sync.OnceValues(func() ([]byte, error) { return capMemory(qjsWasm, MemoryLimit/wasmPage) })

// capMemory sets the maximum pages of a module's one memory, leaving the rest of the module as it is.
func capMemory(wasm []byte, pages uint64) ([]byte, error) {
	if len(wasm) < 8 || string(wasm[:4]) != "\x00asm" {
		return nil, errors.New("not a WebAssembly module")
	}
	for i := 8; i < len(wasm); {
		id := wasm[i]
		size, body, err := uleb(wasm, i+1)
		if err != nil {
			return nil, err
		}
		end := body + int(size)
		if end > len(wasm) {
			return nil, errors.New("a section runs past the module")
		}
		if id != 5 { // the memory section
			i = end
			continue
		}
		count, at, err := uleb(wasm, body)
		if err != nil || count != 1 || at >= end {
			return nil, errors.New("the module does not have exactly one memory")
		}
		flags := wasm[at]
		least, at, err := uleb(wasm, at+1)
		if err != nil {
			return nil, err
		}
		switch flags {
		case 0:
		case 1:
			if _, at, err = uleb(wasm, at); err != nil {
				return nil, err
			}
		default:
			return nil, errors.New("the module's memory is shared or 64-bit")
		}
		if at != end {
			return nil, errors.New("the memory section holds more than its memory")
		}
		if least > pages {
			return nil, errors.New("the module starts with more memory than the cap")
		}
		section := append(leb(1), 1)
		section = append(section, leb(least)...)
		section = append(section, leb(pages)...)
		out := make([]byte, 0, len(wasm)+8)
		out = append(out, wasm[:i]...)
		out = append(out, 5)
		out = append(out, leb(uint64(len(section)))...)
		out = append(out, section...)
		return append(out, wasm[end:]...), nil
	}
	return nil, errors.New("the module has no memory section")
}

// uleb reads an unsigned LEB128 number at i: the number and where what follows starts.
func uleb(b []byte, i int) (uint64, int, error) {
	var n uint64
	for shift := uint(0); shift < 64; shift += 7 {
		if i >= len(b) {
			return 0, 0, errors.New("the module ends inside a number")
		}
		x := b[i]
		i++
		n |= uint64(x&0x7f) << shift
		if x < 0x80 {
			return n, i, nil
		}
	}
	return 0, 0, errors.New("a number in the module is too long")
}

func leb(n uint64) []byte {
	var out []byte
	for {
		c := byte(n & 0x7f)
		if n >>= 7; n == 0 {
			return append(out, c)
		}
		out = append(out, c|0x80)
	}
}
