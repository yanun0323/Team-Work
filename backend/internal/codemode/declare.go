package codemode

import (
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"time"
)

func propName(k string) string {
	for i, r := range k {
		if !(r == '_' || r == '$' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && r >= '0' && r <= '9') {
			return strconv.Quote(k)
		}
	}
	return k
}

// wrap brackets a union, so a suffix such as [] applies to all of it.
func wrap(t string) string {
	whole := strings.HasPrefix(t, "{") && strings.HasSuffix(t, "}") || strings.HasPrefix(t, "Record<") && strings.HasSuffix(t, ">")
	if !whole && strings.Contains(t, " | ") {
		return "(" + t + ")"
	}
	return t
}

var (
	rawMessage = reflect.TypeFor[json.RawMessage]()
	timeType   = reflect.TypeFor[time.Time]()
	marshaler  = reflect.TypeFor[json.Marshaler]()
)

// TypeOf is the TypeScript type of what t marshals to with encoding/json. A slice or map nested in it may be null, as
// Go writes nil ones; the value itself is not. Fields marked omitempty are optional.
func TypeOf(t reflect.Type) string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return goType(t, "", true)
}

func goType(t reflect.Type, indent string, nonNull bool) string {
	switch {
	case t == rawMessage:
		return "unknown"
	case t == timeType:
		return "string"
	case t.Kind() != reflect.Pointer && t.Implements(marshaler), t.Kind() != reflect.Pointer && reflect.PointerTo(t).Implements(marshaler):
		return "unknown"
	}
	switch t.Kind() {
	case reflect.Pointer:
		return wrap(goType(t.Elem(), indent, true)) + " | null"
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64, reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Slice, reflect.Array:
		var out string
		if t.Elem().Kind() == reflect.Uint8 {
			out = "string"
		} else {
			out = wrap(goType(t.Elem(), indent, false)) + "[]"
		}
		if t.Kind() == reflect.Slice && !nonNull {
			out += " | null"
		}
		return out
	case reflect.Map:
		out := "Record<string, " + goType(t.Elem(), indent, false) + ">"
		if !nonNull {
			out += " | null"
		}
		return out
	case reflect.Struct:
		inner := indent + "  "
		var b strings.Builder
		b.WriteString("{\n")
		writeFields(&b, t, inner)
		b.WriteString(indent + "}")
		return b.String()
	}
	return "unknown"
}

// writeFields writes a struct's fields as encoding/json names them, lifting those of untagged embedded structs.
func writeFields(b *strings.Builder, t reflect.Type, indent string) {
	for i := range t.NumField() {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if f.Anonymous && name == "" {
			ft := f.Type
			if ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				writeFields(b, ft, indent)
				continue
			}
		}
		if !f.IsExported() {
			continue
		}
		if name == "" {
			name = f.Name
		}
		omit := strings.Contains(","+opts+",", ",omitempty,") || strings.Contains(","+opts+",", ",omitzero,")
		ft := f.Type
		typ := ""
		if omit {
			// left out when empty, so present means set
			if ft.Kind() == reflect.Pointer {
				ft = ft.Elem()
			}
			typ = goType(ft, indent, true)
		} else {
			typ = goType(ft, indent, false)
		}
		optional := ""
		if omit {
			optional = "?"
		}
		b.WriteString(indent + propName(name) + optional + ": " + typ + ";\n")
	}
}
