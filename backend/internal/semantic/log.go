package semantic

import "github.com/rs/zerolog"

// logger writes semantic search events: the event name is the message, always semantic_ something, so
// `grep semantic_ backend.log` shows the whole story. No event carries code, model input, vectors or tool output;
// the search sentence is written only at debug level.
type logger struct{ z zerolog.Logger }

func (l *logger) event(e *zerolog.Event, name string) *zerolog.Event {
	return e.Str(zerolog.MessageFieldName, name)
}

func (l *logger) debug(name string) *zerolog.Event { return l.event(l.z.Debug(), name) }
func (l *logger) info(name string) *zerolog.Event  { return l.event(l.z.Info(), name) }
func (l *logger) warn(name string) *zerolog.Event  { return l.event(l.z.Warn(), name) }
func (l *logger) error(name string) *zerolog.Event { return l.event(l.z.Error(), name) }
