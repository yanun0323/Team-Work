package providers

import (
	"context"
	"net/http"
	"strings"

	"github.com/yanun0323/Team-Work/internal/model"
	"github.com/yanun0323/Team-Work/internal/providers/codex"
)

// openAIResponses speaks OpenAI's own API through the Responses API, as Codex does with a key and as ChatGPT's
// backend is spoken: nothing stored there, and what the model wrote going back as it came, so the cache holds.
type openAIResponses struct{ openAI }

func (o openAIResponses) Complete(ctx context.Context, req model.ModelRequest, onText func(string)) (model.ModelReply, error) {
	origin := "openai:" + req.Model
	res, err := o.do(ctx, http.MethodPost, "/responses", codex.Request(req, origin, reasons(req.Model)), o.auth)
	if err != nil {
		return model.ModelReply{}, err
	}
	defer res.Body.Close()
	return codex.Read(ctx, res.Body, onText, origin, codex.Wording{
		Unfinished: model.Errorf(model.CodeInvalid, "模型回報錯誤，請檢查模型與設定"),
		Failed: func(string) *model.Error {
			return model.Errorf(model.CodeInvalid, "模型回報錯誤，請檢查模型與設定")
		},
		Cut: model.Errorf(model.CodeUnavailable, "模型回覆沒有結束就中斷了"),
	})
}

// reasons says whether a model reasons, so it can be asked for its reasoning: those that do not refuse the request
// ("Encrypted content is not supported with this model").
func reasons(id string) bool {
	return !strings.HasPrefix(id, "gpt-3") && !strings.HasPrefix(id, "gpt-4") && !strings.HasPrefix(id, "chat") && !strings.Contains(id, "-chat")
}
