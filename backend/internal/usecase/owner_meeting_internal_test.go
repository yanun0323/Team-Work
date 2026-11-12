package usecase

import (
	"slices"
	"testing"

	"github.com/yanun0323/Team-Work/internal/model"
)

func TestMeetingMentionsReadNamesWrittenInWhatWasSaid(t *testing.T) {
	m := &model.Meeting{ChairID: "a", Participants: []model.MeetingParticipant{
		{ReplicaID: "a", Name: "Astra"}, {ReplicaID: "b", Name: "Bob"}, {ReplicaID: "bb", Name: "Bob Lee"},
		{ReplicaID: "d", Name: "介面設計師"}, {ReplicaID: "p", Name: "規劃"}, {ReplicaID: "pp", Name: "規劃大師"},
	}}
	for _, tc := range []struct {
		speaker, text string
		want          []string
	}{
		{"a", "@介面設計師 你回答一下", []string{"d"}},                             // task #60: called by name, not by id
		{"a", "請@介面設計師說明，再請 @Bob 補充", []string{"d", "b"}},                // runs on into CJK text; in the order written
		{"a", "@規劃大師你怎麼看", []string{"pp"}},                               // the longest name that fits
		{"a", "@Bob Lee and @bob, then @Bob again", []string{"bb", "b"}}, // case, the longer name, each once
		{"a", "@Bobby and bob@example.com", nil},                         // a Latin name does not run on into more letters
		{"b", "@Bob @Astra", []string{"a"}},                              // never the speaker; the chair may be called back
		{"a", "@Nobody @Astra 沒有人", nil},                                 // no one in it, or only themselves
		{"a", "trailing @", nil},
	} {
		if got := meetingMentions(m, tc.speaker, tc.text); !slices.Equal(got, tc.want) {
			t.Errorf("%q by %s: got %v, want %v", tc.text, tc.speaker, got, tc.want)
		}
	}
}
