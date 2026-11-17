package usecase

import (
	"reflect"
	"sync"
)

// deepCopy copies v so that changing the copy never changes v, and the other way round. Unlike clone it keeps every
// field, json:"-" ones too, and nil apart from empty, and shares strings, which Go never changes in place: copying the
// world this way allocates a small part of what a JSON round trip does. Funcs, channels and unexported fields are
// shared.
func deepCopy[T any](v T) T {
	var out T
	copyInto(reflect.ValueOf(&out).Elem(), reflect.ValueOf(&v).Elem())
	return out
}

func copyInto(dst, src reflect.Value) {
	if flat(src.Type()) {
		dst.Set(src)
		return
	}
	switch src.Kind() {
	case reflect.Pointer:
		if src.IsNil() {
			dst.SetZero()
			return
		}
		p := reflect.New(src.Type().Elem())
		copyInto(p.Elem(), src.Elem())
		dst.Set(p)
	case reflect.Map:
		if src.IsNil() {
			dst.SetZero()
			return
		}
		m := reflect.MakeMapWithSize(src.Type(), src.Len())
		elem := src.Type().Elem()
		for it := src.MapRange(); it.Next(); {
			v := reflect.New(elem).Elem()
			copyInto(v, it.Value())
			m.SetMapIndex(it.Key(), v)
		}
		dst.Set(m)
	case reflect.Slice:
		if src.IsNil() {
			dst.SetZero()
			return
		}
		s := reflect.MakeSlice(src.Type(), src.Len(), src.Len())
		if flat(src.Type().Elem()) {
			reflect.Copy(s, src)
		} else {
			for i := range src.Len() {
				copyInto(s.Index(i), src.Index(i))
			}
		}
		dst.Set(s)
	case reflect.Array:
		for i := range src.Len() {
			copyInto(dst.Index(i), src.Index(i))
		}
	case reflect.Struct:
		dst.Set(src)
		for i := range src.NumField() {
			if f := dst.Field(i); f.CanSet() && !flat(f.Type()) {
				copyInto(f, src.Field(i))
			}
		}
	case reflect.Interface:
		if src.IsNil() {
			dst.SetZero()
			return
		}
		v := reflect.New(src.Elem().Type()).Elem()
		copyInto(v, src.Elem())
		dst.Set(v)
	default: // funcs, channels, unsafe pointers
		dst.Set(src)
	}
}

var flatTypes sync.Map // reflect.Type → bool

// flat says whether a value of t can be copied by assignment: it holds nothing that a change could reach through.
func flat(t reflect.Type) bool {
	if v, ok := flatTypes.Load(t); ok {
		return v.(bool)
	}
	ok := isFlat(t, map[reflect.Type]bool{})
	flatTypes.Store(t, ok)
	return ok
}

func isFlat(t reflect.Type, seen map[reflect.Type]bool) bool {
	switch t.Kind() {
	case reflect.Pointer, reflect.Map, reflect.Slice, reflect.Interface, reflect.Func, reflect.Chan, reflect.UnsafePointer:
		return false
	case reflect.Array:
		return isFlat(t.Elem(), seen)
	case reflect.Struct:
		if seen[t] {
			return false
		}
		seen[t] = true
		for i := range t.NumField() {
			if !isFlat(t.Field(i).Type, seen) {
				return false
			}
		}
	}
	return true
}
