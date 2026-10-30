// Package jsonx is the JSON codec of the backend. Map keys are sorted, so equal values encode equally.
package jsonx

import "github.com/bytedance/sonic"

var api = sonic.ConfigStd

func Marshal(v any) ([]byte, error)      { return api.Marshal(v) }
func Unmarshal(data []byte, v any) error { return api.Unmarshal(data, v) }
