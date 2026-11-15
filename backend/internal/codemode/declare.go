package codemode

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"time"
)

// Declarations is fns as TypeScript, for the model to read: one function of tools each, in the order given. The same
// fns give the same text.
func Declarations(fns []Func) string {
	var b strings.Builder
	b.WriteString("declare const tools: {\n")
	for _, fn := range fns {
		if d := strings.TrimSpace(fn.Description); d != "" {
			b.WriteString("  /** " + strings.ReplaceAll(d, "*/", "* /") + " */\n")
		}
		returns := fn.Returns
		if returns == "" {
			returns = "unknown"
		}
		b.WriteString("  " + fn.Name + "(args: " + schemaType(fn.Params, "  ") + "): " + returns + ";\n")
	}
	b.WriteString("};\n")
	b.WriteString(parallelDeclaration)
	return b.String()
}

// parallelDeclaration is the global parallel, for calls that do not depend on each other.
const parallelDeclaration = "/** Run several tool calls at the same time and get their results in the order given; each counts as one call. " +
	"A failed call gives {ok: false, error} in its place instead of throwing, so the others are kept. Limits and stopping still end the whole script. */\n" +
	"declare function parallel(calls: { tool: string; args?: object }[]): ({ ok: true; value: any } | { ok: false; error: string })[];"

// schema is the part of JSON Schema tool parameters use.
type schema struct {
	Type                 json.RawMessage   `json:"type"`
	Description          string            `json:"description"`
	Enum                 []json.RawMessage `json:"enum"`
	Items                json.RawMessage   `json:"items"`
	Properties           json.RawMessage   `json:"properties"`
	Required             []string          `json:"required"`
	AdditionalProperties json.RawMessage   `json:"additionalProperties"`
}

func schemaType(raw json.RawMessage, indent string) string {
	var s schema
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return "unknown"
	}
	if len(s.Enum) > 0 {
		parts := make([]string, len(s.Enum))
		for i, v := range s.Enum {
			parts[i] = string(v)
		}
		return strings.Join(parts, " | ")
	}
	var kind string
	_ = json.Unmarshal(s.Type, &kind)
	switch kind {
	case "string":
		return "string"
	case "integer", "number":
		return "number"
	case "boolean":
		return "boolean"
	case "null":
		return "null"
	case "array":
		return wrap(schemaType(s.Items, indent)) + "[]"
	case "object", "":
		keys := orderedKeys(s.Properties)
		if len(keys) == 0 {
			if len(s.AdditionalProperties) > 0 && string(s.AdditionalProperties) != "false" && string(s.AdditionalProperties) != "true" {
				return "Record<string, " + schemaType(s.AdditionalProperties, indent) + ">"
			}
			if kind == "" {
				return "unknown"
			}
			return "{}"
		}
		var props map[string]json.RawMessage
		_ = json.Unmarshal(s.Properties, &props)
		inner := indent + "  "
		var b strings.Builder
		b.WriteString("{\n")
		for _, k := range keys {
			var p schema
			_ = json.Unmarshal(props[k], &p)
			if p.Description != "" {
				b.WriteString(inner + "/** " + strings.ReplaceAll(p.Description, "*/", "* /") + " */\n")
			}
			optional := "?"
			for _, r := range s.Required {
				if r == k {
					optional = ""
				}
			}
			b.WriteString(inner + propName(k) + optional + ": " + schemaType(props[k], inner) + ";\n")
		}
		b.WriteString(indent + "}")
		return b.String()
	}
	return "unknown"
}

// orderedKeys are an object's keys in the order written, so declarations follow the schema.
func orderedKeys(raw json.RawMessage) []string {
	d := json.NewDecoder(bytes.NewReader(raw))
	if t, err := d.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	var keys []string
	for d.More() {
		t, err := d.Token()
		if err != nil {
			return keys
		}
		keys = append(keys, t.(string))
		var skip json.RawMessage
		if d.Decode(&skip) != nil {
			return keys
		}
	}
	return keys
}

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
